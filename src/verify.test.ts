import { describe, expect, test } from "vitest";
import { z } from "zod";
import {
  canReach,
  createTextLogic,
  explorePaths,
  lintAgentMachine,
  PLAN_DONE_EVENT_TYPE,
  setupAgent,
  simulateAgent,
  type AgentLintDiagnostic,
  type AgentPlanOutput,
  type StandardSchemaV1,
} from "./index.js";
import {
  humanInTheLoopMachine,
  jokeMachine,
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
    isSuspended: (snapshot) => snapshot.hasTag("awaiting-human"),
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

// A minimal `agent.plan` machine: one `planning` state whose plan drives
// STEP_A/STEP_B (each appends to `applied`) plus an always-illegal GUARDED
// candidate (guard returns undefined), then settles on the plan's done move.
// The final state copies the plan's `{ steps, stopped }` output into its own.
function createPlanMachine() {
  const agent = setupAgent({
    context: z.object({
      applied: z.array(z.string()),
      // The plan's own onDone output, captured so the final state can expose it.
      planStopped: z.string().nullable(),
      planStepCount: z.number(),
    }),
    output: z.object({
      applied: z.array(z.string()),
      stopped: z.string().nullable(),
      stepCount: z.number(),
    }),
    events: {
      STEP_A: z.object({}),
      STEP_B: z.object({}),
      GUARDED: z.object({}),
    },
  });

  return agent.createMachine({
    context: () => ({ applied: [], planStopped: null, planStepCount: 0 }),
    initial: "planning",
    states: {
      planning: {
        invoke: {
          id: "plan",
          src: "agent.plan",
          input: () => ({
            model: "quick",
            allowedEvents: ["STEP_A", "STEP_B", "GUARDED"] as const,
            maxSteps: 8,
          }),
          // Capture the plan's { steps, stopped } output into context so the
          // final state can expose it (the final output fn is re-evaluated for
          // the root machine-done event, which no longer carries plan output).
          onDone: ({ event }) => {
            const output = (event as { output: AgentPlanOutput }).output;
            return {
              target: "done",
              context: { planStopped: output.stopped, planStepCount: output.steps.length },
            };
          },
        },
        on: {
          STEP_A: ({ context }) => ({ context: { applied: [...context.applied, "A"] } }),
          STEP_B: ({ context }) => ({ context: { applied: [...context.applied, "B"] } }),
          // Always illegal: returning undefined makes the transition guard-reject,
          // so a plan candidate for GUARDED is pruned (exploration) / retried (run).
          GUARDED: () => undefined,
        },
      },
      done: {
        type: "final",
        output: ({ context }) => ({
          applied: context.applied,
          stopped: context.planStopped,
          stepCount: context.planStepCount,
        }),
      },
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
  test("drives twenty-questions to done with scripted decisions/inputs", async () => {
    const result = await simulateAgent(twentyQuestionsMachine, {
      input: { questionsRemaining: 20 },
      script: {
        decisions: { "agent.decide": [{ type: "GUESS", guess: "a cat" }] },
        userInput: { "agent.userInput": ["yes", "no"] },
        text: {
          classifyGuessFeedback: [{ correct: true, reasoning: "matched" }],
          classifyPlayAgain: [{ playAgain: false, reasoning: "stop" }],
        },
      },
    });

    expect(result.status).toBe("done");
    expect((result.snapshot.output as { guess: string }).guess).toBe("a cat");
    expect(result.trail.length).toBeGreaterThan(0);
  });

  test("drives an agent.plan invoke keylessly to done via scripted plan decisions", async () => {
    const result = await simulateAgent(createPlanMachine(), {
      script: {
        // A plan step IS a decision: scripted chosen events keyed by the plan
        // invoke's src, ending with the reserved done move.
        decisions: {
          "agent.plan": [
            { type: "STEP_A" },
            { type: "STEP_B" },
            { type: PLAN_DONE_EVENT_TYPE },
          ],
        },
      },
    });

    expect(result.status).toBe("done");
    // The two machine events applied, in order.
    expect((result.snapshot.context as { applied: string[] }).applied).toEqual(["A", "B"]);
    // The plan's onDone output ({ steps, stopped: 'done' }) landed per the
    // machine's own final-state handling.
    const output = result.snapshot.output as {
      applied: string[];
      stopped: string;
      stepCount: number;
    };
    expect(output.stopped).toBe("done");
    expect(output.stepCount).toBe(2);
    expect(output.applied).toEqual(["A", "B"]);
    // Trail: one entry per applied plan step plus the completing done move.
    expect(result.trail.map((entry) => entry.appliedEvent?.type)).toEqual([
      "STEP_A",
      "STEP_B",
      PLAN_DONE_EVENT_TYPE,
    ]);
  });

  test("throws a descriptive error when the script runs dry", async () => {
    await expect(
      simulateAgent(twentyQuestionsMachine, {
        input: { questionsRemaining: 20 },
        script: {}, // nothing scripted — the first decision has no response
      }),
    ).rejects.toThrow(/script ran dry on a pending decision request for src 'agent\.decide'/);
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

describe("explorePaths — forks plan candidates like decisions", () => {
  test("a plan machine forks per candidate incl. the done move, pruning a guarded candidate", async () => {
    const report = await explorePaths(createPlanMachine(), { maxDepth: 6 });

    // The plan's done move (chosen at any step, incl. immediately) completes the
    // plan → the machine reaches its 'done' final state.
    const doneTerminals = report.terminals.filter((terminal) => terminal.status === "done");
    expect(doneTerminals.length).toBeGreaterThan(0);
    expect(doneTerminals.every((terminal) => terminal.state === "done")).toBe(true);

    // The immediate done-move branch is terminal on its own (a plan that applies
    // nothing then ends): a single-event path of just the reserved done move.
    expect(
      report.terminals.some(
        (terminal) =>
          terminal.status === "done" &&
          terminal.path.length === 1 &&
          terminal.path[0]?.type === PLAN_DONE_EVENT_TYPE,
      ),
    ).toBe(true);

    // Per-event branches were explored too: STEP_A / STEP_B each appear as the
    // first applied plan step on some path.
    const firstSteps = new Set(report.terminals.map((terminal) => terminal.path[0]?.type));
    expect(firstSteps.has("STEP_A")).toBe(true);
    expect(firstSteps.has("STEP_B")).toBe(true);

    // GUARDED is a type-legal plan candidate whose guard always rejects it, so
    // every plan step prunes it — counted, never explored.
    expect(report.prunedByGuard).toBeGreaterThan(0);
    // The always-illegal GUARDED never lands as an applied step on any path.
    expect(
      report.terminals.every((terminal) =>
        terminal.path.every((event) => event.type !== "GUARDED"),
      ),
    ).toBe(true);
  });
});

describe("canReach — reachability with a witness path", () => {
  test("reaches 'denied' via NEEDS_REVIEW then DENY", async () => {
    const result = await canReach(createRefundMachine(), "denied", {
      input: { request: "x", amount: 5000 },
    });
    expect(result.canReach).toBe(true);
    expect(result.witness?.map((event) => event.type)).toEqual(["NEEDS_REVIEW", "DENY"]);
  });

  test("reports unreachable states honestly", async () => {
    const result = await canReach(createRefundMachine(), "nonexistent", {
      input: { request: "x", amount: 5000 },
    });
    expect(result.canReach).toBe(false);
    expect(result.witness).toBeUndefined();
  });
});
