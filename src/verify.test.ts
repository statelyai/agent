import { describe, expect, test } from "vitest";
import { z } from "zod";
import {
  AgentLintError,
  canReach,
  createTextLogic,
  explorePaths,
  lintAgentMachine,
  runAgent,
  setupAgent,
  simulateAgent,
  type AgentLintDiagnostic,
  type ChosenEvent,
} from "./index.js";
import { createDecisionLogic } from "./decision.js";
import { initialAgentStep, rejectAgentStep } from "./steps.js";
import { humanInTheLoopMachine, jokeMachine, twentyQuestionsMachine } from "../examples/index.js";

// A refund machine mirroring the README's keyless example: an `agent.decide`
// that may AUTO_APPROVE (guarded to amount <= 100) or NEEDS_REVIEW, then a human
// gate (APPROVE/DENY) into two final states.
function createRefundMachine() {
  const agent = setupAgent({
    context: z.object({ request: z.string(), amount: z.number() }),
    input: z.object({ request: z.string(), amount: z.number() }),
    output: z.object({ refunded: z.boolean() }),
    events: {
      AUTO_APPROVE: z.object({}),
      NEEDS_REVIEW: z.object({ reason: z.string() }),
      APPROVE: z.object({}),
      DENY: z.object({}),
    },
    isIdle: (snapshot) => snapshot.hasTag("awaiting-human"),
  });

  return agent.createMachine({
    context: ({ input }) => input,
    initial: "deciding",
    states: {
      deciding: {
        invoke: {
          id: "decide",
          src: "agent.decide",
          input: ({ context }) => ({
            model: "quick",
            system: "Decide whether this refund can be auto-approved.",
            prompt: `${context.request} (amount: $${context.amount})`,
            allowedEvents: ["AUTO_APPROVE", "NEEDS_REVIEW"] as const,
          }),
        },
        on: {
          AUTO_APPROVE: ({ context }) =>
            context.amount <= 100 ? { target: "refunded" } : undefined,
          NEEDS_REVIEW: { target: "awaitingHuman" },
        },
      },
      awaitingHuman: {
        tags: ["awaiting-human"],
        on: {
          APPROVE: { target: "refunded" },
          DENY: { target: "denied" },
        },
      },
      refunded: { type: "final", output: () => ({ refunded: true }) },
      denied: { type: "final", output: () => ({ refunded: false }) },
    },
  });
}

// A classifier whose guarded ISSUE is illegal over $100 and whose decision
// invoke routes exhaustion to `refused` via onError — the adversarial-model
// shape used by the retry-parity tests below.
function createGuardedIssueMachine() {
  const agent = setupAgent({
    context: z.object({ amount: z.number() }),
    input: z.object({ amount: z.number() }),
    events: { ISSUE: z.object({}), REFUSE: z.object({}) },
  });
  return agent.createMachine({
    context: ({ input }) => input,
    initial: "classifying",
    states: {
      classifying: {
        invoke: {
          id: "decide",
          src: "agent.decide",
          input: () => ({
            model: "quick",
            prompt: "Issue or refuse?",
            allowedEvents: ["ISSUE", "REFUSE"] as const,
          }),
          onError: { target: "refused" },
        },
        on: {
          ISSUE: ({ context }) => (context.amount > 100 ? undefined : { target: "issued" }),
          REFUSE: { target: "refused" },
        },
      },
      issued: { type: "final" },
      refused: { type: "final" },
    },
  });
}

const errorsOf = (diagnostics: AgentLintDiagnostic[]) =>
  diagnostics.filter((diagnostic) => diagnostic.severity === "error");

describe("lintAgentMachine — the lint corpus stays quiet", () => {
  test.each([
    ["joke", jokeMachine],
    ["human-in-the-loop", humanInTheLoopMachine],
    ["twenty-questions", twentyQuestionsMachine],
    ["refund", createRefundMachine()],
  ])("%s produces zero error-severity diagnostics", (_name, machine) => {
    expect(errorsOf(lintAgentMachine(machine))).toEqual([]);
  });
});

describe("lintAgentMachine — each check fires on a crafted bad machine", () => {
  test("unhandled-agent-messages: text requests without a root transcript transition warn", () => {
    const agent = setupAgent({
      context: z.object({ messages: z.array(z.unknown()) }),
      requests: {
        answer: { schemas: {}, model: "test", prompt: "answer" },
      },
    });
    const machine = agent.createMachine({
      context: { messages: [] },
      initial: "answering",
      states: {
        answering: { invoke: { src: "answer", onDone: { target: "done" } } },
        done: { type: "final" },
      },
    });

    expect(lintAgentMachine(machine)).toContainEqual(
      expect.objectContaining({
        code: "unhandled-agent-messages",
        severity: "warning",
        path: "(root)",
      }),
    );
    expect(
      lintAgentMachine(machine, { disable: ["unhandled-agent-messages"] }).some(
        (diagnostic) => diagnostic.code === "unhandled-agent-messages",
      ),
    ).toBe(false);
  });

  test("unhandled-agent-messages: a state-scoped transcript transition is recognized", () => {
    const agent = setupAgent({
      context: z.object({ messages: z.array(z.unknown()) }),
      requests: {
        answer: { schemas: {}, model: "test", prompt: "answer" },
      },
    });
    const machine = agent.createMachine({
      context: { messages: [] },
      initial: "answering",
      states: {
        answering: {
          on: { "agent.messages": agent.appendMessages() },
          invoke: { src: "answer", onDone: { target: "done" } },
        },
        done: { type: "final" },
      },
    });

    expect(
      lintAgentMachine(machine).some(
        (diagnostic) => diagnostic.code === "unhandled-agent-messages",
      ),
    ).toBe(false);
  });

  test("decide-without-events: an agent.decide state with no on/ancestor handlers", () => {
    const agent = setupAgent({
      context: z.object({}),
      events: { GO: z.object({}) },
    });
    const machine = agent.createMachine({
      context: () => ({}),
      initial: "deciding",
      states: {
        deciding: {
          invoke: {
            src: "agent.decide",
            input: () => ({ model: "m", allowedEvents: ["GO"] as const }),
          },
        },
        done: { type: "final" },
      },
    });

    const diagnostics = lintAgentMachine(machine);
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        code: "decide-without-events",
        severity: "error",
        path: "deciding",
      }),
    );
  });

  test("direct-object-src: an inline (non-string) agent logic src (warning)", () => {
    const inlineLogic = createTextLogic({
      schemas: { input: z.object({}), output: z.string() },
      model: "m",
      prompt: "work",
    });
    const agent = setupAgent({
      context: z.object({}),
      events: { E: z.object({}) },
    });
    const machine = agent.createMachine({
      context: () => ({}),
      initial: "s",
      states: {
        s: {
          invoke: { id: "inline", src: inlineLogic as never, onDone: { target: "done" } },
        },
        done: { type: "final" },
      },
    });

    const diagnostics = lintAgentMachine(machine);
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ code: "direct-object-src", severity: "warning", path: "s" }),
    );
  });
});

describe("simulateAgent — keyless deterministic playthrough", () => {
  // Player turns in twenty-questions are idle states resumed by external
  // events. With no `events` scripted, a playthrough settles at the first
  // player turn; the `events` queue (tested below) crosses such gates.
  test("drives twenty-questions through scripted decisions to the first player turn", async () => {
    const result = await simulateAgent(twentyQuestionsMachine, {
      input: { questionsRemaining: 1 },
      script: {
        decisions: { "agent.decide": [{ type: "GUESS", guess: "a cat" }] },
      },
    });

    expect(result.status).toBe("idle");
    expect(result.snapshot.value).toBe("awaitingGuessFeedback");
    expect(result.snapshot.context.guess).toBe("a cat");
    expect(result.trail).toContainEqual(
      expect.objectContaining({ appliedEvent: { type: "GUESS", guess: "a cat" } }),
    );
  });

  test("the scripted playthrough's idle turn can still reach gameOver", async () => {
    const result = await canReach(twentyQuestionsMachine, "gameOver", {
      input: { questionsRemaining: 1 },
    });
    expect(result.reachable).toBe(true);
  });

  test("does not drain the caller's scripted queues", async () => {
    // Two jokes per run: the machine always takes one improvement pass before
    // the decision is asked for.
    const script = {
      text: {
        tellJoke: ["Why did the state cross the transition?", "The state crossed. Twice."],
        rateJoke: [
          { rating: 4, explanation: "Setup drags." },
          { rating: 9, explanation: "Punchy." },
        ],
      },
      decisions: { "agent.decide": [{ type: "END" } as const] },
    };

    const first = await simulateAgent(jokeMachine, { input: { topic: "states" }, script });
    expect(first.status).toBe("done");

    // The same script object must still be usable: simulateAgent consumes
    // copies of every queue, never the caller's arrays.
    expect(script.text.tellJoke).toHaveLength(2);
    expect(script.text.rateJoke).toHaveLength(2);
    expect(script.decisions["agent.decide"]).toHaveLength(1);

    const second = await simulateAgent(jokeMachine, { input: { topic: "states" }, script });
    expect(second.status).toBe("done");
  });

  test("throws a descriptive error when the script runs dry", async () => {
    await expect(
      simulateAgent(twentyQuestionsMachine, {
        input: { questionsRemaining: 20 },
        script: {}, // nothing scripted — the first decision has no response
      }),
    ).rejects.toThrow(/script ran dry on a pending decision request for src 'agent\.decide'/);
  });

  test("the trail starts with the initial state (a complete state path)", async () => {
    const result = await simulateAgent(createRefundMachine(), {
      input: { request: "small refund", amount: 50 },
      script: { decisions: { "agent.decide": [{ type: "AUTO_APPROVE" }] } },
    });

    expect(result.status).toBe("done");
    expect(result.trail[0]).toEqual({ state: "deciding" });
    // No hand-prepending needed to compare trajectories.
    expect(result.trail.map((entry) => entry.state)).toEqual(["deciding", "refunded"]);
  });
});

describe("simulateAgent — live-run decision retry semantics", () => {
  test("a guard-rejected scripted decision retries with the next queued one", async () => {
    // AUTO_APPROVE is guard-rejected at $5000; a live run re-asks the model,
    // so the simulation consumes the next scripted decision for the same src.
    const result = await simulateAgent(createRefundMachine(), {
      input: { request: "big refund", amount: 5000 },
      script: {
        decisions: {
          "agent.decide": [
            { type: "AUTO_APPROVE" },
            { type: "NEEDS_REVIEW", reason: "over limit" },
          ],
        },
      },
    });

    expect(result.status).toBe("idle");
    expect(result.snapshot.value).toBe("awaitingHuman");
    expect(result.trail).toContainEqual({
      state: "awaitingHuman",
      appliedEvent: { type: "NEEDS_REVIEW", reason: "over limit" },
      rejectedEvents: [{ type: "AUTO_APPROVE" }],
    });
  });

  test("an unknown scripted event type is rejected and retried, like live validation", async () => {
    // Comes free from delegating to resolveDecision: the typo'd type is not
    // among the request's candidate events, so it fails 'unknown-event' and
    // the next queued decision is tried — a live run behaves identically.
    const result = await simulateAgent(createRefundMachine(), {
      input: { request: "small refund", amount: 50 },
      script: {
        decisions: { "agent.decide": [{ type: "AUTO_APPROVE_TYPO" }, { type: "AUTO_APPROVE" }] },
      },
    });

    expect(result.status).toBe("done");
    expect(result.snapshot.value).toBe("refunded");
    expect(result.trail).toContainEqual(
      expect.objectContaining({
        appliedEvent: { type: "AUTO_APPROVE" },
        rejectedEvents: [{ type: "AUTO_APPROVE_TYPO" }],
      }),
    );
  });

  test("an all-rejected queue routes decision exhaustion through the invoke's onError", async () => {
    // The adversarial "model" only ever tries the guarded ISSUE. Live, the
    // decision exhausts and its error routes via onError; the simulation
    // agrees rather than parking idle.
    const result = await simulateAgent(createGuardedIssueMachine(), {
      input: { amount: 5000 },
      script: { decisions: { "agent.decide": [{ type: "ISSUE" }] } },
    });

    expect(result.status).toBe("done");
    expect(result.snapshot.value).toBe("refused");
    expect(result.trail).toContainEqual({
      state: "refused",
      rejectedEvents: [{ type: "ISSUE" }],
    });
  });

  test("an all-rejected queue with no onError throws AgentDecisionExhaustedError", async () => {
    // The last queued decision repeats for the remaining retries (a scripted
    // model that insists), so the default budget of 3 attempts is spent — the
    // same count a live adversarial model would produce.
    await expect(
      simulateAgent(createRefundMachine(), {
        input: { request: "big refund", amount: 5000 },
        script: { decisions: { "agent.decide": [{ type: "AUTO_APPROVE" }] } },
      }),
    ).rejects.toThrow(/Decision exhausted after 3 attempts.*guard rejected/);
  });

  test("a direct-object decision logic's own maxRetries caps scripted attempts", async () => {
    // maxRetries: 0 → exactly one attempt. The logic rides on the invoke
    // itself (no string src, nothing registered), so the budget must come from
    // the spawn metadata — and the script queue is keyed by the invoke id.
    const choose = createDecisionLogic({
      model: "quick",
      prompt: "Go or stop?",
      allowedEvents: ["GO", "STOP"],
      maxRetries: 0,
    });
    const agent = setupAgent({
      context: z.object({}),
      events: { GO: z.object({}), STOP: z.object({}) },
    });
    const machine = agent.createMachine({
      context: () => ({}),
      initial: "a",
      states: {
        a: {
          invoke: { id: "choose", src: choose },
          on: {
            GO: () => undefined, // always guard-rejected
            STOP: { target: "done" },
          },
        },
        done: { type: "final" },
      },
    });

    await expect(
      simulateAgent(machine, {
        script: { decisions: { choose: [{ type: "GO" }] } },
      }),
    ).rejects.toThrow(/Decision exhausted after 1 attempt\b/);
  });
});

describe("simulateAgent — scripted external events cross human gates", () => {
  test("the `events` queue resumes an idle wait, all the way to done", async () => {
    const result = await simulateAgent(createRefundMachine(), {
      input: { request: "big refund", amount: 5000 },
      script: {
        decisions: { "agent.decide": [{ type: "NEEDS_REVIEW", reason: "over limit" }] },
        events: [{ type: "APPROVE" }],
      },
    });

    expect(result.status).toBe("done");
    expect(result.snapshot.value).toBe("refunded");
    expect(result.trail).toContainEqual({
      state: "refunded",
      appliedEvent: { type: "APPROVE" },
      external: true,
    });
    expect(result.trail.map((entry) => entry.state)).toEqual([
      "deciding",
      "awaitingHuman",
      "refunded",
    ]);
  });

  test("an external event the state cannot take throws instead of vanishing", async () => {
    await expect(
      simulateAgent(createRefundMachine(), {
        input: { request: "big refund", amount: 5000 },
        script: {
          decisions: { "agent.decide": [{ type: "NEEDS_REVIEW", reason: "over limit" }] },
          events: [{ type: "AUTO_APPROVE" }], // not handled at the human gate
        },
      }),
    ).rejects.toThrow(/external event 'AUTO_APPROVE' cannot be taken in state "awaitingHuman"/);
  });
});

describe("simulateAgent ↔ runAgent — the same script produces the same outcome", () => {
  // The live-run counterpart of a simulation script: a `decide` executor that
  // dequeues one scripted decision per attempt and repeats the last one when
  // the queue runs dry mid-retry — simulateAgent's exact convention, including
  // its scope: the repeat only spans one request's retries (`request.attempts`
  // is empty on a fresh request, where a dry queue is an error instead).
  const scriptedDecide = (queue: ChosenEvent[]) => {
    const remaining = [...queue];
    let last: ChosenEvent | undefined;
    return async (request: { attempts: readonly unknown[] }) => {
      if (request.attempts.length === 0) {
        last = undefined;
      }
      last = remaining.shift() ?? last;
      if (!last) {
        throw new Error("scripted decide: queue is empty");
      }
      return { event: last };
    };
  };

  test("guard-rejected then accepted: both surfaces settle idle at the human gate", async () => {
    const decisions: ChosenEvent[] = [
      { type: "AUTO_APPROVE" },
      { type: "NEEDS_REVIEW", reason: "over limit" },
    ];
    const input = { request: "big refund", amount: 5000 };

    const simulated = await simulateAgent(createRefundMachine(), {
      input,
      script: { decisions: { "agent.decide": decisions } },
    });
    const live = await runAgent(createRefundMachine(), {
      input,
      executors: { decide: scriptedDecide(decisions) },
    });

    expect(simulated.status).toBe("idle");
    expect(live.status).toBe("idle");
    expect(live.snapshot.value).toEqual(simulated.snapshot.value); // 'awaitingHuman'
  });

  test("adversarial exhaustion: both surfaces route through onError to 'refused'", async () => {
    const decisions: ChosenEvent[] = [{ type: "ISSUE" }];
    const input = { amount: 5000 };

    const simulated = await simulateAgent(createGuardedIssueMachine(), {
      input,
      script: { decisions: { "agent.decide": decisions } },
    });
    const live = await runAgent(createGuardedIssueMachine(), {
      input,
      executors: { decide: scriptedDecide(decisions) },
    });

    expect(simulated.status).toBe("done");
    expect(live.status).toBe("done");
    expect(live.snapshot.value).toEqual(simulated.snapshot.value); // 'refused'
  });
});

describe("canReach — predicate targets", () => {
  // A refund flow whose `approved` flag is written ONLY by the human gate's
  // APPROVE — so "issued over the limit without approval" is a genuine
  // state+context property that changes along paths, not a constant of the
  // input.
  function createApprovalMachine() {
    const agent = setupAgent({
      context: z.object({ amount: z.number(), approved: z.boolean() }),
      input: z.object({ amount: z.number() }),
      events: {
        ISSUE: z.object({}),
        ESCALATE: z.object({}),
        APPROVE: z.object({}),
        REJECT: z.object({}),
      },
      isIdle: (snapshot) => snapshot.hasTag("awaiting-approval"),
    });
    return agent.createMachine({
      context: ({ input }) => ({ amount: input.amount, approved: false }),
      initial: "classifying",
      states: {
        classifying: {
          invoke: {
            id: "decide",
            src: "agent.decide",
            input: () => ({
              model: "quick",
              prompt: "Issue or escalate?",
              allowedEvents: ["ISSUE", "ESCALATE"] as const,
            }),
          },
          on: {
            ISSUE: ({ context }) =>
              context.amount > 100 && !context.approved ? undefined : { target: "issued" },
            ESCALATE: { target: "approving" },
          },
        },
        approving: {
          tags: ["awaiting-approval"],
          on: {
            // The only writer of `approved`.
            APPROVE: () => ({ target: "issued", context: { approved: true } }),
            REJECT: { target: "rejected" },
          },
        },
        issued: { type: "final" },
        rejected: { type: "final" },
      },
    });
  }

  test("a snapshot predicate can express a violation property without a sentinel state", async () => {
    type Ctx = { amount: number; approved: boolean };

    // The safety property: over the limit, `issued` is never entered without
    // `approved` — a predicate over context that only APPROVE can flip, so
    // this is decided by exploration, not by the input alone.
    const violation = await canReach(
      createApprovalMachine(),
      (snapshot) =>
        snapshot.matches("issued") &&
        (snapshot.context as Ctx).amount > 100 &&
        !(snapshot.context as Ctx).approved,
      { input: { amount: 5000 } },
    );
    expect(violation.reachable).toBe(false);

    // The same terminal state IS reachable with approval on record — the
    // witness must pass through the human gate.
    const legal = await canReach(
      createApprovalMachine(),
      (snapshot) => snapshot.matches("issued") && (snapshot.context as Ctx).approved,
      { input: { amount: 5000 } },
    );
    expect(legal.reachable).toBe(true);
    expect(legal.witness?.map((event) => event.type)).toEqual(["ESCALATE", "APPROVE"]);

    // Below the limit, the direct ISSUE is legal and the violation predicate
    // (approved never set) still has no witness.
    const small = await canReach(
      createApprovalMachine(),
      (snapshot) => snapshot.matches("issued") && !(snapshot.context as Ctx).approved,
      { input: { amount: 40 } },
    );
    expect(small.reachable).toBe(true);
    expect(small.witness?.map((event) => event.type)).toEqual(["ISSUE"]);
  });
});

describe("explorePaths — enumerates decision + human branches", () => {
  test("refund (amount > 100) finds both terminals and prunes the guarded AUTO_APPROVE", async () => {
    const report = await explorePaths(createRefundMachine(), {
      input: { request: "Refund my duplicate charge", amount: 5000 },
    });

    const done = report.terminals.filter((terminal) => terminal.status === "done");
    const finalStates = done.map((terminal) => terminal.state).sort();
    expect(finalStates).toEqual(["denied", "refunded"]);

    // AUTO_APPROVE is type-legal but its guard rejects amount > 100 → one prune.
    expect(report.prunedByGuard).toBe(1);
    expect(report.reachedStates).toEqual(
      expect.arrayContaining(["deciding", "awaitingHuman", "refunded", "denied"]),
    );
  });

  test("refund (amount <= 100) can auto-approve without the human gate", async () => {
    const report = await explorePaths(createRefundMachine(), {
      input: { request: "small refund", amount: 50 },
    });
    expect(report.prunedByGuard).toBe(0);
    expect(report.terminals.some((terminal) => terminal.state === "refunded")).toBe(true);
  });
});

describe("canReach — reachability with a witness path", () => {
  test("reaches 'denied' via NEEDS_REVIEW then DENY", async () => {
    const result = await canReach(createRefundMachine(), "denied", {
      input: { request: "x", amount: 5000 },
    });
    expect(result.reachable).toBe(true);
    expect(result.witness?.map((event) => event.type)).toEqual(["NEEDS_REVIEW", "DENY"]);
  });

  test("throws for an unknown state target", async () => {
    await expect(
      canReach(createRefundMachine(), "nonexistent", {
        input: { request: "x", amount: 5000 },
      }),
    ).rejects.toMatchObject({ code: "unknown-state", target: "nonexistent" });
  });

  test("finds a state passed through mid-chain between two text requests", async () => {
    // `middle` is entered and immediately left while exploration resolves the
    // chained text requests — the target check must run on every intermediate
    // snapshot, not only where a path settles.
    const agent = setupAgent({ context: z.object({}) });
    const machine = agent.createMachine({
      context: () => ({}),
      initial: "first",
      states: {
        first: {
          invoke: {
            id: "t1",
            src: "agent.generateText",
            input: () => ({ model: "quick", prompt: "one" }),
            onDone: { target: "middle" },
          },
        },
        middle: {
          invoke: {
            id: "t2",
            src: "agent.generateText",
            input: () => ({ model: "quick", prompt: "two" }),
            onDone: { target: "last" },
          },
        },
        last: { type: "final" },
      },
    });
    const text = { "agent.generateText": "canned" };

    const byPath = await canReach(machine, "middle", { text });
    expect(byPath.reachable).toBe(true);
    expect(byPath.witness).toEqual([]);

    const byPredicate = await canReach(machine, (snapshot) => snapshot.matches("middle"), {
      text,
    });
    expect(byPredicate.reachable).toBe(true);
  });

  test("accepts state-node IDs as targets", async () => {
    const agent = setupAgent({ context: z.object({}), events: { GO: z.object({}) } });
    const machine = agent.createMachine({
      id: "id-targets",
      context: {},
      initial: "first",
      states: {
        first: { on: { GO: { target: "second" } } },
        second: { id: "custom-second" },
      },
    });

    await expect(canReach(machine, "custom-second")).resolves.toMatchObject({
      reachable: true,
      target: "custom-second",
      witness: [{ type: "GO" }],
    });
    await expect(canReach(machine, "#custom-second")).resolves.toMatchObject({
      reachable: true,
      target: "custom-second",
    });
  });
});

describe("lintAgentMachine({ throw: true })", () => {
  test("throws for an agent-specific error", () => {
    const agent = setupAgent({
      context: z.object({}),
      events: { GO: z.object({}) },
    });
    const machine = agent.createMachine({
      id: "broken-agent",
      context: {},
      initial: "deciding",
      states: {
        deciding: {
          invoke: {
            src: "agent.decide",
            input: { name: "choose", model: "m", allowedEvents: ["GO"] },
          },
        },
      },
    });

    expect(() => lintAgentMachine(machine, { throw: true })).toThrow(AgentLintError);
  });
});

// A machine whose only pending work is an `agent.userInput` invoke, for the
// scripted `userInput` channel.
function createFeedbackMachine() {
  const agent = setupAgent({
    context: z.object({ feedback: z.string().nullable() }),
    input: z.object({}),
    output: z.object({ feedback: z.string() }),
    events: {},
  });
  return agent.createMachine({
    id: "feedback",
    context: () => ({ feedback: null }),
    initial: "asking",
    states: {
      asking: {
        invoke: {
          id: "ask",
          src: "agent.userInput",
          input: { prompt: "How was it?" },
          onDone: ({ output }) => ({ target: "done", context: { feedback: output } }),
        },
      },
      done: {
        type: "final",
        output: ({ context }) => ({ feedback: context.feedback ?? "" }),
      },
    },
  });
}

describe("scripted key taxonomy — userInput", () => {
  test("simulateAgent resolves agent.userInput from the `userInput` queue", async () => {
    const result = await simulateAgent(createFeedbackMachine(), {
      input: {},
      script: { userInput: ["great"] },
    });

    expect(result.status).toBe("done");
    expect(result.snapshot.context.feedback).toBe("great");
    expect(result.trail).toContainEqual(
      expect.objectContaining({
        resolvedRequest: expect.objectContaining({ kind: "userInput", src: "agent.userInput" }),
      }),
    );
  });

  test("simulateAgent still accepts the by-src `invokes` form", async () => {
    const result = await simulateAgent(createFeedbackMachine(), {
      input: {},
      script: { invokes: { "agent.userInput": ["fine"] } },
    });
    expect(result.snapshot.context.feedback).toBe("fine");
  });

  test("a dry userInput queue throws, naming the queue to add to", async () => {
    await expect(simulateAgent(createFeedbackMachine(), { input: {}, script: {} })).rejects.toThrow(
      /script ran dry on a pending userInput request.*`userInput` queue/s,
    );
  });

  test("explorePaths resolves agent.userInput from `userInput`, and reports a missing one", async () => {
    const explored = await explorePaths(createFeedbackMachine(), {
      input: {},
      userInput: "great",
    });
    expect(explored.terminals.map((terminal) => terminal.status)).toEqual(["done"]);

    const blocked = await explorePaths(createFeedbackMachine(), { input: {} });
    expect(blocked.terminals[0]).toEqual(
      expect.objectContaining({ status: "needs-output", missingSrc: "agent.userInput" }),
    );
  });

  test("explorePaths reads text requests from `text`", async () => {
    const report = await explorePaths(jokeMachine, {
      input: { topic: "state machines" },
      text: {
        tellJoke: "Why did the state cross the transition?",
        rateJoke: { rating: 4, explanation: "Setup drags." },
      },
    });
    expect(report.terminals.some((terminal) => terminal.status === "needs-output")).toBe(false);
  });
});

describe("invoke-without-on-error", () => {
  const agent = setupAgent({
    context: z.object({ topic: z.string() }),
    events: { RETRY: z.object({}) },
  });

  const makeMachine = (states: Record<string, unknown>) =>
    agent.createMachine({
      context: { topic: "otters" },
      initial: "drafting",
      states: states as never,
    });

  const findings = (machine: Parameters<typeof lintAgentMachine>[0]) =>
    lintAgentMachine(machine).filter((d) => d.code === "invoke-without-on-error");

  test("warns on an invoke with no onError anywhere", () => {
    const diagnostics = findings(
      makeMachine({
        drafting: {
          invoke: {
            src: "agent.generateText",
            input: () => ({ model: "quick", prompt: "draft" }),
            onDone: { target: "done" },
          },
        },
        done: { type: "final" },
      }),
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ severity: "warning", path: "drafting" });
    expect(diagnostics[0]!.message).toContain("agent.generateText");
  });

  test("is silent when the machine root handles actor errors", () => {
    const machine = agent.createMachine({
      context: { topic: "otters" },
      initial: "drafting",
      on: { "xstate.error.actor.*": { target: ".failed" } } as never,
      states: {
        drafting: {
          invoke: {
            src: "agent.generateText",
            input: () => ({ model: "quick", prompt: "draft" }),
            onDone: { target: "done" },
          },
        },
        failed: { type: "final" },
        done: { type: "final" },
      } as never,
    });
    expect(findings(machine)).toEqual([]);
  });

  test("is silent when the invoke declares onError", () => {
    expect(
      findings(
        makeMachine({
          drafting: {
            invoke: {
              src: "agent.generateText",
              input: () => ({ model: "quick", prompt: "draft" }),
              onDone: { target: "done" },
              onError: { target: "failed" },
            },
          },
          done: { type: "final" },
          failed: { type: "final" },
        }),
      ),
    ).toEqual([]);
  });

  test("is silent when an ancestor handles the actor error", () => {
    expect(
      findings(
        makeMachine({
          drafting: {
            on: { "xstate.error.actor.*": { target: "failed" } },
            initial: "working",
            states: {
              working: {
                invoke: {
                  src: "agent.generateText",
                  input: () => ({ model: "quick", prompt: "draft" }),
                  onDone: { target: "#done" },
                },
              },
            },
          },
          done: { id: "done", type: "final" },
          failed: { type: "final" },
        }),
      ),
    ).toEqual([]);
  });

  test("never fails assertAgentMachine by default (warning severity)", () => {
    const machine = makeMachine({
      drafting: {
        invoke: {
          src: "agent.generateText",
          input: () => ({ model: "quick", prompt: "draft" }),
          onDone: { target: "done" },
        },
      },
      done: { type: "final" },
    });
    expect(() => lintAgentMachine(machine, { throw: true })).not.toThrow();
    expect(() => lintAgentMachine(machine, { throw: true, warnings: true })).toThrow(
      AgentLintError,
    );
    expect(
      lintAgentMachine(machine, { disable: ["invoke-without-on-error"] }).map((d) => d.code),
    ).not.toContain("invoke-without-on-error");
  });
});

// A parse-then-report machine whose `parse` text request can fail: `failed` is
// reachable only through the invoke's `onError`, which copies the failure's
// `code` into context so a test can see the scripted error value arrive intact.
function createParsingMachine() {
  const agent = setupAgent({
    context: z.object({ code: z.string() }),
    requests: { parse: { schemas: {}, model: "test", prompt: "parse it" } },
  });
  return agent.createMachine({
    context: { code: "" },
    initial: "parsing",
    states: {
      parsing: {
        invoke: {
          id: "parse",
          src: "parse",
          onDone: { target: "parsed" },
          onError: ({ event }) => ({
            target: "failed",
            context: { code: failureCode(event.error) },
          }),
        },
      },
      parsed: { type: "final" },
      failed: { type: "final" },
    },
  });
}

// The same machine with no `onError` anywhere — a rejected `parse` errors the run.
function createUncaughtParsingMachine() {
  const agent = setupAgent({
    context: z.object({ code: z.string() }),
    requests: { parse: { schemas: {}, model: "test", prompt: "parse it" } },
  });
  return agent.createMachine({
    context: { code: "" },
    initial: "parsing",
    states: {
      parsing: { invoke: { id: "parse", src: "parse", onDone: { target: "parsed" } } },
      parsed: { type: "final" },
    },
  });
}

function failureCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : "";
}

describe("simulateAgent — scripted invoke failures", () => {
  test("an errors entry is consumed before the output queue and routes to onError", async () => {
    const machine = createParsingMachine();
    const script = {
      errors: { parse: [new Error("bad json")] },
      text: { parse: [{ total: 1 }] },
    };

    const result = await simulateAgent(machine, { script });

    expect(result.status).toBe("done");
    expect(result.snapshot.value).toBe("failed");
    // The output queue is untouched: the error was consumed first.
    expect(script.text.parse).toHaveLength(1);
  });

  test("the trail records the rejection with the scripted error value", async () => {
    const error = new Error("bad json");
    const result = await simulateAgent(createParsingMachine(), {
      script: { errors: { parse: [error] } },
    });

    expect(result.trail.at(-1)?.resolvedRequest).toEqual({
      kind: "text",
      src: "parse",
      id: "parse",
      outcome: "error",
      error,
    });
  });

  test("a resolved request's trail entry reports outcome 'output'", async () => {
    const result = await simulateAgent(createParsingMachine(), {
      script: { text: { parse: [{ total: 1 }] } },
    });

    expect(result.snapshot.value).toBe("parsed");
    expect(result.trail.at(-1)?.resolvedRequest).toEqual({
      kind: "text",
      src: "parse",
      id: "parse",
      outcome: "output",
    });
  });

  test("a non-Error failure value reaches onError as event.error, untouched", async () => {
    const result = await simulateAgent(createParsingMachine(), {
      script: { errors: { parse: [{ code: "truncated" }] } },
    });

    expect(result.snapshot.value).toBe("failed");
    expect((result.snapshot.context as { code: string }).code).toBe("truncated");
    expect(result.trail.at(-1)?.resolvedRequest?.error).toEqual({ code: "truncated" });
  });

  test("only the first queued error fails; the next call takes the output queue", async () => {
    const result = await simulateAgent(createParsingMachine(), {
      script: { errors: { parse: [new Error("once")] }, text: { parse: [{ total: 1 }] } },
    });
    const second = await simulateAgent(createParsingMachine(), {
      script: { errors: { parse: [] }, text: { parse: [{ total: 1 }] } },
    });

    expect(result.snapshot.value).toBe("failed");
    expect(second.snapshot.value).toBe("parsed");
  });

  test("a decide error stands in for retry exhaustion and hits the decide invoke's onError", async () => {
    const exhausted = new Error("model would not choose");
    const result = await simulateAgent(createGuardedIssueMachine(), {
      input: { amount: 50 },
      script: { errors: { "agent.decide": [exhausted] } },
    });

    expect(result.snapshot.value).toBe("refused");
    expect(result.trail.at(-1)?.resolvedRequest).toEqual({
      kind: "decision",
      src: "agent.decide",
      id: "decide",
      outcome: "error",
      error: exhausted,
    });
  });

  test("an unhandled scripted error throws the scripted Error itself", async () => {
    const error = new Error("bad json");

    await expect(
      simulateAgent(createUncaughtParsingMachine(), { script: { errors: { parse: [error] } } }),
    ).rejects.toBe(error);
  });

  test("an unhandled non-Error failure throws a descriptive error carrying it as `cause`", async () => {
    await expect(
      simulateAgent(createUncaughtParsingMachine(), {
        script: { errors: { parse: [{ code: "truncated" }] } },
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("reached no onError transition"),
      cause: { code: "truncated" },
    });
  });
});

describe("explorePaths — scripted invoke failures fork a branch", () => {
  test("a src with only an error fails on every branch", async () => {
    const report = await explorePaths(createParsingMachine(), {
      errors: { parse: new Error("bad json") },
    });

    expect(report.terminals).toEqual([
      { status: "done", path: [{ type: "xstate.error.actor.parse" }], state: "failed" },
    ]);
    expect(report.reachedStates).toEqual(["parsing", "failed"]);
  });

  test("a src with both an error and an output explores both branches", async () => {
    const report = await explorePaths(createParsingMachine(), {
      text: { parse: { total: 1 } },
      errors: { parse: new Error("bad json") },
    });

    expect(report.terminals.map((terminal) => terminal.state).sort()).toEqual(["failed", "parsed"]);
    expect(report.pathsExplored).toBe(2);
  });

  test("canReach finds an onError-only state, with the failure in the witness", async () => {
    const { reachable, witness } = await canReach(createParsingMachine(), "failed", {
      errors: { parse: new Error("bad json") },
    });

    expect(reachable).toBe(true);
    expect(witness).toEqual([{ type: "xstate.error.actor.parse" }]);
  });

  test("that state is unreachable without a scripted error", async () => {
    const { reachable } = await canReach(createParsingMachine(), "failed", {
      text: { parse: { total: 1 } },
    });

    expect(reachable).toBe(false);
  });

  test("guard pruning and path counts are unchanged when no errors are scripted", async () => {
    const machine = createRefundMachine();
    const options = { input: { request: "Refund my duplicate charge", amount: 5000 } };

    const baseline = await explorePaths(machine, options);
    const withEmptyErrors = await explorePaths(machine, { ...options, errors: {} });

    expect(withEmptyErrors).toEqual(baseline);
    expect(baseline.prunedByGuard).toBe(1);
  });
});

describe("rejectAgentStep", () => {
  test("delivers the error to the invoke's onError and returns the next step", () => {
    const machine = createParsingMachine();
    const step = initialAgentStep(machine, undefined);
    const next = rejectAgentStep(machine, step, step.requests[0]!, { code: "truncated" });

    expect(next.snapshot.value).toBe("failed");
    expect((next.snapshot.context as { code: string }).code).toBe("truncated");
    expect(next.done).toBe(true);
  });

  test("errors the snapshot when no onError catches it", () => {
    const machine = createUncaughtParsingMachine();
    const step = initialAgentStep(machine, undefined);
    const next = rejectAgentStep(machine, step, "parse", new Error("bad json"));

    expect(next.snapshot.status).toBe("error");
  });
});

// Three concurrent `draft` invokes with targetless `onDone`/`onError`s and an
// `always` join — the fan-out shape whose siblings a per-transition view of
// pending work forgets once the first invoke settles.
const DRAFT_SLOTS = ["draft1", "draft2", "draft3"];

type FanOutContext = { drafts: string[]; settled: number };

function createFanOutMachine() {
  const agent = setupAgent({
    context: z.object({ drafts: z.array(z.string()), settled: z.number() }),
    requests: { draft: { schemas: { output: z.string() }, model: "test", prompt: "write it" } },
  });
  return agent.createMachine({
    id: "fan-out",
    context: { drafts: [], settled: 0 },
    initial: "drafting",
    states: {
      drafting: {
        invoke: DRAFT_SLOTS.map((id) => ({
          id,
          src: "draft" as const,
          onDone: ({ context, output }: { context: FanOutContext; output: string }) => ({
            context: { drafts: [...context.drafts, output], settled: context.settled + 1 },
          }),
          onError: ({ context }: { context: FanOutContext }) => ({
            context: { settled: context.settled + 1 },
          }),
        })),
        // Nothing leaves `drafting` until every slot has settled.
        always: ({ context }) => {
          if (context.settled < DRAFT_SLOTS.length) {
            return;
          }
          return context.drafts.length > 0
            ? { target: "done" as const }
            : { target: "failed" as const };
        },
      },
      done: { type: "final" },
      failed: { type: "final" },
    },
  });
}

describe("concurrent invokes — every pending invoke stays visible", () => {
  test("simulateAgent resolves all three slots, then the always join settles done", async () => {
    const result = await simulateAgent(createFanOutMachine(), {
      script: { text: { draft: ["one", "two", "three"] } },
    });

    expect(result.status).toBe("done");
    expect(result.snapshot.value).toBe("done");
    expect(result.snapshot.context.settled).toBe(3);
    // Resolved in invoke-id order, so the drafts arrive in queue order.
    expect(result.snapshot.context.drafts).toEqual(["one", "two", "three"]);
    expect(
      result.trail.flatMap((entry) => (entry.resolvedRequest ? [entry.resolvedRequest.id] : [])),
    ).toEqual(DRAFT_SLOTS);
  });

  test("explorePaths forks per invoke, reaching both the join and the failure branch", async () => {
    const report = await explorePaths(createFanOutMachine(), {
      text: { draft: "one" },
      errors: { draft: new Error("truncated") },
    });

    expect(report.reachedStates).toEqual(expect.arrayContaining(["drafting", "done", "failed"]));
    expect(report.terminals.map((terminal) => terminal.state)).toContain("done");
    expect(report.terminals.map((terminal) => terminal.state)).toContain("failed");
  });

  test("canReach finds the error-only state behind three failed slots", async () => {
    const { reachable, witness } = await canReach(createFanOutMachine(), "failed", {
      errors: { draft: new Error("truncated") },
    });

    expect(reachable).toBe(true);
    expect(witness).toEqual(DRAFT_SLOTS.map((id) => ({ type: `xstate.error.actor.${id}` })));
  });
});
