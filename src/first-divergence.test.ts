import { describe, expect, test } from "vitest";
import { z } from "zod";
import type { AgentDecisionExecutor } from "./decision.js";
import {
  createAgentRuntime,
  createAgentSchemas,
  runToQuiescence,
  serializeTraceEvent,
  setupAgent,
  type AgentTraceEvent,
} from "./index.js";
import { firstDivergence, foldTraces } from "./testing/index.js";

const schemas = createAgentSchemas({
  context: z.object({ limit: z.number() }),
  input: z.object({}),
  events: { refund: z.object({ amount: z.number() }), escalate: z.object({}) },
});

const desk = setupAgent({ schemas }).createMachine({
  context: { limit: 50 },
  initial: "deciding",
  states: {
    deciding: {
      invoke: {
        src: "agent.decide",
        input: {
          name: "chooseResolution",
          model: "quick",
          allowedEvents: ["refund", "escalate"],
          payloads: { refund: [{ amount: 20 }] },
        },
      },
      on: {
        refund: { target: "refunded" },
        escalate: { target: "escalated" },
      },
    },
    refunded: { type: "final" },
    escalated: { type: "final" },
  },
});

const choose =
  (type: string): AgentDecisionExecutor =>
  async (request) => ({
    event: request.options!.find((option) => option.event.type === type)!.event,
  });

async function run(type: string): Promise<AgentTraceEvent[]> {
  const trace: AgentTraceEvent[] = [];
  await runToQuiescence(
    createAgentRuntime(desk, {
      executors: { decide: choose(type) },
      onTrace: (event) => trace.push(event),
    }),
    { input: {} },
  );
  return trace;
}

const step = (from: unknown, type: string, to: unknown) => ({
  type: "machine.transition",
  from: { value: from },
  event: { type },
  snapshot: { value: to },
});

describe("firstDivergence", () => {
  test("blames the decision state where two runs chose differently", async () => {
    const divergence = firstDivergence(await run("escalate"), await run("refund"));

    expect(divergence).toMatchObject({
      index: 0,
      state: "deciding",
      decision: "chooseResolution",
      actual: { event: "escalate", to: ["escalated"] },
      expected: { event: "refund", to: ["refunded"] },
    });
  });

  test("blames the invoking state when an output routes elsewhere", async () => {
    const agent = setupAgent({
      input: z.object({}),
      context: z.object({}),
      requests: {
        check: {
          model: "quick",
          schemas: { input: z.object({}), output: z.string() },
          prompt: () => "Check it.",
        },
      },
    });
    const machine = agent.createMachine({
      context: {},
      initial: "checking",
      states: {
        checking: {
          invoke: {
            src: "check",
            input: {},
            onDone: ({ output }) => ({ target: output.result === "ok" ? "passed" : "rejected" }),
          },
        },
        passed: { type: "final" },
        rejected: { type: "final" },
      },
    });
    const traceOf = async (answer: string) => {
      const trace: AgentTraceEvent[] = [];
      await runToQuiescence(
        createAgentRuntime(machine, {
          executors: { generateText: async () => ({ result: answer }) },
          onTrace: (event) => trace.push(event),
        }),
        { input: {} },
      );
      return trace;
    };

    const divergence = firstDivergence(await traceOf("no"), await traceOf("ok"));

    expect(divergence).toMatchObject({ index: 0, state: "checking", actual: { to: ["rejected"] } });
    expect(divergence?.decision).toBeUndefined();
  });

  test("a run that ended early diverges where it stopped", () => {
    const reference = [step("a", "@xstate.init", "a"), step("a", "GO", "b"), step("b", "GO", "c")];
    const actual = reference.slice(0, 2);

    expect(firstDivergence(actual, reference)).toEqual({
      index: 1,
      state: "b",
      expected: expect.objectContaining({ event: "GO", to: ["c"] }),
    });
  });

  test("a run that went on past the reference diverges at its extra step", () => {
    const actual = [step("a", "@xstate.init", "a"), step("a", "GO", "b"), step("b", "GO", "c")];

    expect(firstDivergence(actual, actual.slice(0, 2))).toMatchObject({
      index: 1,
      state: "b",
      actual: { event: "GO" },
    });
  });

  test("an empty reference is a trace with no steps", () => {
    const actual = [step("a", "@xstate.init", "a"), step("a", "GO", "b")];

    expect(firstDivergence(actual, [])).toMatchObject({ index: 0, state: "a" });
    expect(firstDivergence([], [])).toBeUndefined();
    expect(firstDivergence(actual, [{ type: "run.start" }, { type: "run.end" }])).toMatchObject({
      index: 0,
    });
  });

  test("identical runs do not diverge, ignored steps aside", async () => {
    const trace = await run("refund");
    const noisy = [...trace];
    noisy.splice(2, 0, { ...step("deciding", "PING", "deciding"), ignored: true } as never);

    expect(firstDivergence(trace, await run("refund"))).toBeUndefined();
    expect(firstDivergence(noisy, trace)).toBeUndefined();
  });

  test("key leaves out what equivalent runs may differ in", () => {
    const a = [
      step({ main: "idle", log: "quiet" }, "@xstate.init", { main: "idle", log: "quiet" }),
      step({ main: "idle", log: "quiet" }, "GO", { main: "busy", log: "quiet" }),
    ];
    const b = [
      step({ main: "idle", log: "quiet" }, "@xstate.init", { main: "idle", log: "quiet" }),
      step({ main: "idle", log: "quiet" }, "GO", { main: "busy", log: "noisy" }),
    ];
    const mainOnly = (s: { from: string[]; event: string; to: string[] }) =>
      `${s.from.filter((leaf) => leaf.startsWith("main."))}|${s.event}|${s.to.filter((leaf) => leaf.startsWith("main."))}`;

    expect(firstDivergence(a, b)?.index).toBe(0);
    expect(firstDivergence(a, b, { key: mainOnly })).toBeUndefined();
  });

  test("against a trajectory, blames the step after the last item reached", async () => {
    const escalated = await run("escalate");

    expect(firstDivergence(escalated, ["deciding", "refunded"])).toMatchObject({
      index: 0,
      state: "deciding",
      decision: "chooseResolution",
      expected: "refunded",
    });
    expect(firstDivergence(escalated, ["deciding", "escalate", "escalated"])).toBeUndefined();
    expect(firstDivergence(escalated, [{ type: "escalate" }])).toBeUndefined();
  });

  test("against a trajectory, a run that stops short diverges at its end", () => {
    const trace = [step("a", "@xstate.init", "a"), step("a", "GO", "b")];

    expect(firstDivergence(trace, ["a", "b", "c"])).toEqual({
      index: 1,
      state: "b",
      expected: "c",
    });
    expect(firstDivergence([step("a", "@xstate.init", "a")], ["b"])).toEqual({
      index: 0,
      state: "a",
      expected: "b",
    });
  });

  test("reads serialized traces the same way", async () => {
    const serialize = (trace: AgentTraceEvent[]) =>
      trace.map((event) => JSON.parse(JSON.stringify(serializeTraceEvent(event))));
    const actual = await run("escalate");
    const reference = await run("refund");

    expect(firstDivergence(serialize(actual), serialize(reference))).toEqual(
      firstDivergence(actual, reference),
    );
  });
});

describe("foldTraces blame", () => {
  test("counts each failed run once, against the state it diverged in", async () => {
    const passing = await run("refund");
    const traces = [passing, await run("escalate"), await run("escalate")];
    const failed = (trace: readonly { type: string }[]) => trace !== passing;

    const stats = foldTraces(traces, {
      failed,
      blame: (trace) => firstDivergence(trace, passing)?.state,
    });

    expect(stats.map(({ state, failures, blamed }) => ({ state, failures, blamed }))).toEqual([
      { state: "deciding", failures: 2, blamed: 2 },
      { state: "refunded", failures: 0, blamed: 0 },
      { state: "escalated", failures: 2, blamed: 0 },
    ]);
  });

  test("blames nothing for passing runs or an undefined blame", async () => {
    const traces = [await run("refund"), await run("escalate")];
    let calls = 0;

    const stats = foldTraces(traces, {
      failed: (trace) => trace === traces[1],
      blame: () => {
        calls++;
        return undefined;
      },
    });

    expect(calls).toBe(1);
    expect(stats.every((row) => row.blamed === 0)).toBe(true);
  });
});
