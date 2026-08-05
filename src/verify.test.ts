import { describe, expect, test } from "vitest";
import { z } from "zod";
import {
  AgentLintError,
  assertAgentMachine,
  canReach,
  createTextLogic,
  explorePaths,
  lintAgentMachine,
  setupAgent,
  simulateAgent,
  type AgentLintDiagnostic,
  type AgentWorkflowConfig,
  type SchemaCompiler,
  type StandardSchemaV1,
} from "./index.js";
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
  // events, and `SimulationScript` has no channel for delivering those, so a
  // scripted playthrough settles at the first player turn. `canReach` covers
  // the rest of the path (it forks on externally-accepted events).
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
    expect(result.canReach).toBe(true);
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

describe("assertAgentMachine — one-line pass/fail for tests", () => {
  test("returns silently for a clean machine", () => {
    expect(() => assertAgentMachine(jokeMachine)).not.toThrow();
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
      assertAgentMachine(machine);
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

    expect(() => assertAgentMachine(machine)).not.toThrow();
    expect(() => assertAgentMachine(machine, { warnings: true })).toThrow(AgentLintError);
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

    expect(() => assertAgentMachine(machine)).toThrow(AgentLintError);
    expect(() => assertAgentMachine(machine, { disable: ["unreachable-state"] })).not.toThrow();
  });
});
