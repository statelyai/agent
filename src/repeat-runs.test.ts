import { describe, expect, test } from "vitest";
import { z } from "zod";
import type { AgentDecisionExecutor } from "./decision.js";
import {
  createAgentRuntime,
  createAgentSchemas,
  runToQuiescence,
  setupAgent,
  type AgentTraceEvent,
} from "./index.js";
import { foldTraces, repeatRuns, summarizeRepeats } from "./testing/index.js";

const schemas = createAgentSchemas({
  context: z.object({}),
  input: z.object({}),
  events: { refund: z.object({}), escalate: z.object({}) },
});

const desk = setupAgent({ schemas }).createMachine({
  context: {},
  initial: "deciding",
  states: {
    deciding: {
      invoke: {
        src: "agent.decide",
        input: { name: "chooseResolution", model: "quick", allowedEvents: ["refund", "escalate"] },
      },
      on: { refund: { target: "refunded" }, escalate: { target: "escalated" } },
    },
    refunded: { type: "final" },
    escalated: { type: "final" },
  },
});

const choose =
  (type: string): AgentDecisionExecutor =>
  async () => ({ event: { type } });

async function run(type: string) {
  const trace: AgentTraceEvent[] = [];
  const result = await runToQuiescence(
    createAgentRuntime(desk, {
      executors: { decide: choose(type) },
      onTrace: (event) => trace.push(event),
    }),
    { input: {} },
  );
  return { trace, outcome: String(result.snapshot.value) };
}

describe("repeatRuns", () => {
  test("reports pass@k, pass^k, distinct paths, and where runs split", async () => {
    // "flaky" escalates on its second and fourth runs.
    const answers: Record<string, string[]> = {
      steady: ["refund", "refund", "refund", "refund"],
      flaky: ["refund", "escalate", "refund", "escalate"],
    };

    const report = await repeatRuns({
      scenarios: [{ id: "steady" }, { id: "flaky" }],
      k: 4,
      run: (scenario, attempt) => run(answers[scenario.id]![attempt]!),
      passed: (_, { outcome }) => outcome === "refunded",
    });

    expect(
      report.scenarios.map(({ id, passes, passAny, passAll, distinctPaths, divergedAt }) => ({
        id,
        passes,
        passAny,
        passAll,
        distinctPaths,
        divergedAt,
      })),
    ).toEqual([
      {
        id: "steady",
        passes: 4,
        passAny: true,
        passAll: true,
        distinctPaths: 1,
        divergedAt: undefined,
      },
      {
        id: "flaky",
        passes: 2,
        passAny: true,
        passAll: false,
        distinctPaths: 2,
        divergedAt: "deciding",
      },
    ]);
    expect(report.traces).toHaveLength(8);
    expect(foldTraces(report.traces, { failed: () => false })[0]).toMatchObject({
      state: "deciding",
      visits: 8,
    });
  });

  test("a run that throws fails with its message and no trace", async () => {
    const report = await repeatRuns({
      scenarios: [{ id: "a" }],
      k: 2,
      run: async (_, attempt) => {
        if (attempt === 1) throw new Error("provider down");
        return run("refund");
      },
      passed: () => true,
    });

    expect(report.scenarios[0]!.runs[1]).toEqual({ passed: false, error: "provider down" });
    expect(report.scenarios[0]!.passes).toBe(1);
    expect(report.traces).toHaveLength(1);
  });

  test("rejects a k below 1", async () => {
    await expect(
      repeatRuns({ scenarios: [], k: 0, run: () => run("refund"), passed: () => true }),
    ).rejects.toMatchObject({ code: "invalid-repeat-count" });
  });
});

describe("summarizeRepeats", () => {
  const group = (id: string, results: boolean[]) => ({
    id,
    scenario: { id },
    runs: results.map((passed) => ({ passed })),
  });

  test("passHat is the unbiased pass^j estimate, averaged over scenarios", () => {
    const report = summarizeRepeats([
      group("none", [false, false, false, false]),
      group("all", [true, true, true, true]),
      group("half", [true, true, false, false]),
    ]);

    // half: C(2,1)/C(4,1) = 1/2, C(2,2)/C(4,2) = 1/6, C(2,3)/C(4,3) = 0.
    expect(report.passHat(1)).toBeCloseTo((0 + 1 + 1 / 2) / 3);
    expect(report.passHat(2)).toBeCloseTo((0 + 1 + 1 / 6) / 3);
    expect(report.passHat(3)).toBeCloseTo((0 + 1 + 0) / 3);
    expect(report.passHat(4)).toBeCloseTo(1 / 3);
  });

  test("scenarios with fewer than j runs are left out of passHat", () => {
    const report = summarizeRepeats([group("short", [false]), group("long", [true, true])]);

    expect(report.passHat(1)).toBeCloseTo(1 / 2);
    expect(report.passHat(2)).toBe(1);
  });

  test("passHat rejects j outside 1 to the most runs", () => {
    const report = summarizeRepeats([group("a", [true, true])]);

    for (const j of [0, 3, 1.5]) {
      expect(() => report.passHat(j)).toThrow(
        expect.objectContaining({ code: "pass-hat-out-of-range" }),
      );
    }
  });

  test("untraced runs count toward passes but not paths", () => {
    const [row] = summarizeRepeats([group("a", [true, false])]).scenarios;

    expect(row).toMatchObject({ passes: 1, passAny: true, passAll: false, distinctPaths: 0 });
    expect(row!.divergedAt).toBeUndefined();
  });
});
