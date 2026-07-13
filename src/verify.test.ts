import { describe, expect, test } from "vitest";
import { z } from "zod";
import {
  canReach,
  createTextLogic,
  explorePaths,
  lintAgentMachine,
  setupAgent,
  simulateAgent,
  type AgentLintDiagnostic,
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
  test("drives twenty-questions to done with scripted decisions/inputs", () => {
    const result = simulateAgent(twentyQuestionsMachine, {
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

  test("throws a descriptive error when the script runs dry", () => {
    expect(() =>
      simulateAgent(twentyQuestionsMachine, {
        input: { questionsRemaining: 20 },
        script: {}, // nothing scripted — the first decision has no response
      }),
    ).toThrow(/script ran dry on a pending decision request for src 'agent\.decide'/);
  });
});

describe("explorePaths — enumerates decision + human branches", () => {
  test("refund (amount > 100) finds both terminals and prunes the guarded AUTO_APPROVE", () => {
    const report = explorePaths(createRefundMachine(), {
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

  test("refund (amount <= 100) can auto-approve without the human gate", () => {
    const report = explorePaths(createRefundMachine(), {
      input: { request: "small refund", amount: 50 },
    });
    expect(report.prunedByGuard).toBe(0);
    expect(report.terminals.some((terminal) => terminal.state === "refunded")).toBe(true);
  });
});

describe("canReach — reachability with a witness path", () => {
  test("reaches 'denied' via NEEDS_REVIEW then DENY", () => {
    const result = canReach(createRefundMachine(), "denied", {
      input: { request: "x", amount: 5000 },
    });
    expect(result.canReach).toBe(true);
    expect(result.witness?.map((event) => event.type)).toEqual(["NEEDS_REVIEW", "DENY"]);
  });

  test("reports unreachable states honestly", () => {
    const result = canReach(createRefundMachine(), "nonexistent", {
      input: { request: "x", amount: 5000 },
    });
    expect(result.canReach).toBe(false);
    expect(result.witness).toBeUndefined();
  });
});
