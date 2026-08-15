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
  type AgentWorkflowConfig,
  type SchemaCompiler,
  type StandardSchemaV1,
} from "./index.js";
import { createDecisionLogic } from "./decision.js";
import * as examples from "../examples/index.js";
import {
  humanInTheLoopMachine,
  jokeMachine,
  jsonAgentMachine,
  twentyQuestionsMachine,
} from "../examples/index.js";

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

  test("no example machine trips 'final-output-reads-event'", () => {
    const tripped: string[] = [];
    for (const [name, value] of Object.entries(examples)) {
      const machine = value as { config?: unknown };
      if (!machine || typeof machine !== "object" || typeof machine.config !== "object") {
        continue;
      }
      try {
        if (lintAgentMachine(machine as never).some((d) => d.code === "final-output-reads-event")) {
          tripped.push(name);
        }
      } catch {
        // Not a lintable machine export — skip.
      }
    }
    expect(tripped).toEqual([]);
  });

  test("a hand-authored function target still over-approximates rather than false-flag", () => {
    // Unchanged behavior for TS-authored machines: `b` is only ever entered by a
    // dynamic transition, which lint cannot read, so it must stay quiet.
    const agent = setupAgent({
      context: z.object({ n: z.number() }),
      events: { E: z.object({}) },
    });
    const machine = agent.createMachine({
      context: () => ({ n: 0 }),
      initial: "a",
      states: {
        a: { on: { E: ({ context }) => (context.n > 0 ? { target: "b" } : undefined) } },
        b: { type: "final" },
      },
    });

    expect(lintAgentMachine(machine).filter((d) => d.code === "unreachable-state")).toEqual([]);
  });
});

// A pass-through `compileSchema` for `fromConfig` lint tests: it validates
// nothing, but exposes the JSON Schema, which is all the lint checks read.
const passthroughCompiler: SchemaCompiler = (jsonSchema): StandardSchemaV1 => ({
  "~standard": {
    version: 1,
    vendor: "verify-test",
    validate: (value: unknown) => ({ value }),
    jsonSchema: { input: () => jsonSchema },
  } as never,
});

const fromConfigMachine = (config: AgentWorkflowConfig) =>
  setupAgent.fromConfig(config, { compileSchema: passthroughCompiler }).machine;

describe("lintAgentMachine — fromConfig machines lint on their declared graph", () => {
  test("json-agent (targets folded behind context patches) is completely clean", () => {
    // Regression: xstate's JSON layer rewrites a transition that carries an
    // `assign` into an opaque `to` resolver with no `target`. Every state here
    // but `drafting` is entered that way, so reachability used to see no edges
    // and flag `awaitingApproval`/`resolved` unreachable plus `missing-final`.
    expect(lintAgentMachine(jsonAgentMachine)).toEqual([]);
  });

  test("the retained targets survive machine.provide(...)", () => {
    expect(lintAgentMachine(jsonAgentMachine.provide({}))).toEqual([]);
  });

  test("a config machine whose transitions carry emit actions still lints clean", () => {
    // Regression companion to the json-agent case: an `emit` in a transition
    // folds the target behind a resolver the same way `assign` does.
    const machine = fromConfigMachine({
      id: "emit-config",
      schemas: {
        context: { type: "object", properties: {} },
        events: { GO: { type: "object" } },
        emitted: { MOVED: { type: "object", properties: {} } },
      },
      initial: "a",
      states: {
        a: { on: { GO: { target: "b", actions: { emit: { type: "MOVED" } } } } },
        b: { type: "final" },
      },
    } as AgentWorkflowConfig);

    expect(lintAgentMachine(machine)).toEqual([]);
  });

  test("a config state nothing targets is still reported unreachable", () => {
    const machine = fromConfigMachine({
      id: "orphan-config",
      schemas: { context: { type: "object", properties: {} }, events: { GO: { type: "object" } } },
      initial: "a",
      states: {
        a: { on: { GO: { target: "b", assign: { seen: true } } } },
        b: { type: "final" },
        orphan: {},
      },
    } as AgentWorkflowConfig);

    const diagnostics = lintAgentMachine(machine);
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ code: "unreachable-state", severity: "error", path: "orphan" }),
    );
    // The `assign`-carrying edge into the final state is still seen, so
    // reachability is exact here, not over-approximated to "everything".
    expect(diagnostics.filter((d) => d.code === "unreachable-state")).toHaveLength(1);
    expect(diagnostics.some((d) => d.code === "missing-final")).toBe(false);
  });

  test("nested and choice targets are retained too", () => {
    const machine = fromConfigMachine({
      id: "nested-config",
      schemas: { context: { type: "object", properties: {} } },
      initial: "outer",
      states: {
        outer: {
          initial: "pick",
          states: {
            pick: { type: "choice", choice: [{ target: "chosen", assign: { picked: true } }] },
            chosen: { type: "final" },
          },
          onDone: { target: "settled", assign: { settled: true } },
        },
        settled: { type: "final" },
      },
    } as AgentWorkflowConfig);

    expect(lintAgentMachine(machine).filter((d) => d.code === "unreachable-state")).toEqual([]);
  });
});

describe("lintAgentMachine — each check fires on a crafted bad machine", () => {
  test("unreachable-state: an orphan state with no incoming target", () => {
    const agent = setupAgent({
      context: z.object({}),
      events: { E: z.object({}), F: z.object({}) },
    });
    const machine = agent.createMachine({
      context: () => ({}),
      initial: "a",
      states: {
        a: { on: { E: { target: "b" } } },
        b: { type: "final" },
        c: { on: { F: { target: "b" } } }, // nothing targets `c`
      },
    });

    const diagnostics = lintAgentMachine(machine);
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ code: "unreachable-state", severity: "error", path: "c" }),
    );
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

  test("undeclared-event: an `on:` key not in schemas.events and not builtin (warning)", () => {
    const agent = setupAgent({
      context: z.object({}),
      events: { GO: z.object({}) },
    });
    const machine = agent.createMachine({
      context: () => ({}),
      initial: "a",
      states: {
        a: { on: { GO: { target: "b" }, TYPOED: { target: "b" }, "*": { target: "b" } } },
        b: { type: "final" },
      },
    });

    const diagnostics = lintAgentMachine(machine);
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ code: "undeclared-event", severity: "warning", path: "a" }),
    );
    // Declared `GO` and wildcard `*` do not warn — only the undeclared `TYPOED`.
    expect(diagnostics.filter((d) => d.code === "undeclared-event")).toHaveLength(1);
  });

  test("unserializable-context: a context schema with no JSON schema (warning)", () => {
    const rawContext: StandardSchemaV1<Record<string, unknown>> = {
      "~standard": {
        version: 1,
        vendor: "verify-test",
        validate: (value) => ({ value: value as Record<string, unknown> }),
      },
    };
    const agent = setupAgent({
      context: rawContext,
      events: { E: z.object({}) },
    });
    const machine = agent.createMachine({
      context: () => ({}),
      initial: "a",
      states: { a: { on: { E: { target: "b" } } }, b: { type: "final" } },
    });

    const diagnostics = lintAgentMachine(machine);
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        code: "unserializable-context",
        severity: "warning",
        path: "context",
      }),
    );
    // A warning must never count as an error for the CLI/CI gate.
    expect(errorsOf(diagnostics)).toEqual([]);
  });

  test("direct-object-src: an inline (non-string) agent logic src (warning)", () => {
    const inlineLogic = createTextLogic({
      schemas: { input: z.object({}), output: z.string() },
      model: "m",
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

  test("final-without-output: declared output schema, a final lacking output", () => {
    const agent = setupAgent({
      context: z.object({}),
      output: z.object({ ok: z.boolean() }),
      events: { E: z.object({}) },
    });
    const machine = agent.createMachine({
      context: () => ({}),
      initial: "a",
      states: {
        a: { on: { E: { target: "b" } } },
        b: { type: "final" }, // no output, but the machine declares one
      },
    });

    const diagnostics = lintAgentMachine(machine);
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        code: "final-without-output",
        severity: "error",
        path: "b",
      }),
    );
  });

  test("final-output-reads-event: a top-level final whose output reads event (warning)", () => {
    const agent = setupAgent({
      context: z.object({}),
      output: z.object({ echoed: z.string() }),
      events: { E: z.object({ value: z.string() }) },
    });
    const machine = agent.createMachine({
      context: () => ({}),
      initial: "a",
      states: {
        a: { on: { E: { target: "b" } } },
        // Reads the entering event in the final output — the anti-pattern.
        b: {
          type: "final",
          output: ({ event }) => ({ echoed: (event as { value: string }).value }),
        },
      },
    });

    const diagnostics = lintAgentMachine(machine);
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        code: "final-output-reads-event",
        severity: "warning",
        path: "b",
      }),
    );
    // A warning must never count as an error for the CLI/CI gate.
    expect(errorsOf(diagnostics)).toEqual([]);
  });

  test("final-output-reads-event: quiet when a context-only final output", () => {
    const agent = setupAgent({
      context: z.object({ captured: z.string() }),
      output: z.object({ echoed: z.string() }),
      events: { E: z.object({ value: z.string() }) },
    });
    const machine = agent.createMachine({
      context: () => ({ captured: "" }),
      initial: "a",
      states: {
        a: { on: { E: { target: "b" } } },
        // The final output reads context only — the correct pattern.
        b: { type: "final", output: ({ context }) => ({ echoed: context.captured }) },
      },
    });

    expect(lintAgentMachine(machine).some((d) => d.code === "final-output-reads-event")).toBe(
      false,
    );
  });

  test("missing-final: a machine that can only loop", () => {
    const agent = setupAgent({
      context: z.object({}),
      events: { E: z.object({}) },
    });
    const machine = agent.createMachine({
      context: () => ({}),
      initial: "a",
      states: {
        a: { on: { E: { target: "b" } } },
        b: { on: { E: { target: "a" } } },
      },
    });

    const diagnostics = lintAgentMachine(machine);
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ code: "missing-final", severity: "warning", path: "(root)" }),
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
      isSuspended: (snapshot) => snapshot.hasTag("awaiting-approval"),
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

  test("reports unreachable states honestly", async () => {
    const result = await canReach(createRefundMachine(), "nonexistent", {
      input: { request: "x", amount: 5000 },
    });
    expect(result.reachable).toBe(false);
    expect(result.witness).toBeUndefined();
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
});

describe("lintAgentMachine({ throw: true }) — one-line pass/fail for tests", () => {
  test("returns silently for a clean machine", () => {
    expect(() => lintAgentMachine(jokeMachine, { throw: true })).not.toThrow();
  });

  test("throws AgentLintError with the findings for a broken machine", () => {
    const agent = setupAgent({
      context: z.object({}),
      events: { E: z.object({}), F: z.object({}) },
    });
    const machine = agent.createMachine({
      id: "broken",
      context: () => ({}),
      initial: "a",
      states: {
        a: { on: { E: { target: "b" } } },
        b: { type: "final" },
        c: { on: { F: { target: "b" } } }, // nothing targets `c`
      },
    });

    let thrown: unknown;
    try {
      lintAgentMachine(machine, { throw: true });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AgentLintError);
    const lintError = thrown as AgentLintError;
    expect(lintError.diagnostics).toContainEqual(
      expect.objectContaining({ code: "unreachable-state", severity: "error", path: "c" }),
    );
    expect(lintError.message).toContain("'broken'");
    expect(lintError.message).toContain("unreachable-state");
    expect(lintError.message).toContain("c");
  });

  test("warnings pass by default; warnings: true fails them", () => {
    const agent = setupAgent({
      context: z.object({}),
      events: { E: z.object({}) },
    });
    // No reachable final state: a warning-severity 'missing-final' finding.
    const machine = agent.createMachine({
      id: "loopy",
      context: () => ({}),
      initial: "a",
      states: {
        a: { on: { E: { target: "a" } } },
      },
    });

    expect(() => lintAgentMachine(machine, { throw: true })).not.toThrow();
    expect(() => lintAgentMachine(machine, { throw: true, warnings: true })).toThrow(
      AgentLintError,
    );
  });

  test("forwards lint options: a disabled check no longer fails the assert", () => {
    const agent = setupAgent({
      context: z.object({}),
      events: { E: z.object({}), F: z.object({}) },
    });
    const machine = agent.createMachine({
      context: () => ({}),
      initial: "a",
      states: {
        a: { on: { E: { target: "b" } } },
        b: { type: "final" },
        c: { on: { F: { target: "b" } } },
      },
    });

    expect(() => lintAgentMachine(machine, { throw: true })).toThrow(AgentLintError);
    expect(() =>
      lintAgentMachine(machine, { throw: true, disable: ["unreachable-state"] }),
    ).not.toThrow();
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
