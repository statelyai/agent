import { describe, expect, test } from "vitest";
import { z } from "zod";
import { createActor, createAsyncLogic, createMachine, toPromise } from "xstate";
import type { AgentDecisionExecutor } from "./decision.js";
import {
  createAgentRuntime,
  createAgentSchemas,
  runToQuiescence,
  serializeTraceEvent,
  setupAgent,
  traceTransitions,
  type AgentTraceEvent,
} from "./index.js";
import { explorePaths } from "./testing/index.js";
import { traceCoverage } from "./trace-coverage.js";

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
          model: "quick",
          allowedEvents: ["refund", "escalate"],
          payloads: { refund: [{ amount: 20 }, { amount: 80 }] },
        },
      },
      on: {
        refund: ({ context, event }) =>
          event.amount <= context.limit ? { target: "refunded" } : undefined,
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

const step = (from: unknown, type: string, to: unknown, extra: Record<string, unknown> = {}) => ({
  type: "machine.transition",
  from: { value: from },
  event: { type, ...extra },
  snapshot: { value: to },
});

describe("traceCoverage", () => {
  test("reports the branch no run took", async () => {
    const report = traceCoverage(desk, [await run("refund")]);

    expect(report.states).toEqual([
      { state: "deciding", runs: 1 },
      { state: "refunded", runs: 1 },
      { state: "escalated", runs: 0 },
    ]);
    expect(report.unvisitedStates).toEqual(["escalated"]);
    expect(report.handlers).toEqual([
      {
        state: "deciding",
        event: "refund",
        runs: 1,
        targets: { declared: "dynamic", seen: ["refunded"], unreached: [] },
      },
      {
        state: "deciding",
        event: "escalate",
        runs: 0,
        targets: { declared: ["escalated"], seen: [], unreached: ["escalated"] },
      },
    ]);
    expect(report.unvisitedHandlers).toEqual([{ state: "deciding", event: "escalate" }]);
    expect(report.ratio).toEqual({ states: 2 / 3, handlers: 1 / 2 });
  });

  test("counts runs per trace, not per step", async () => {
    const report = traceCoverage(desk, [
      await run("refund"),
      await run("escalate"),
      await run("escalate"),
    ]);

    expect(report.states.map((row) => row.runs)).toEqual([3, 1, 2]);
    expect(report.handlers.map((row) => row.runs)).toEqual([1, 2]);
    expect(report.ratio).toEqual({ states: 1, handlers: 1 });
  });

  test("a child leaf credits its parent's handler", () => {
    const machine = createMachine({
      initial: "work",
      states: {
        work: {
          initial: "draft",
          on: { cancel: { target: "cancelled" } },
          states: {
            draft: { on: { submit: { target: "review" } } },
            review: {},
          },
        },
        cancelled: { type: "final" },
      },
    });
    const trace = [
      step({ work: "draft" }, "submit", { work: "review" }),
      step({ work: "review" }, "cancel", "cancelled"),
    ];

    const report = traceCoverage(machine, [trace]);

    expect(report.states).toEqual([
      { state: "work.draft", runs: 1 },
      { state: "work.review", runs: 1 },
      { state: "cancelled", runs: 1 },
    ]);
    expect(report.handlers.map(({ state, event, runs }) => ({ state, event, runs }))).toEqual([
      { state: "work", event: "cancel", runs: 1 },
      { state: "work.draft", event: "submit", runs: 1 },
    ]);
  });

  test("an exact descriptor beats a partial one, and a partial one beats `*`", () => {
    const machine = createMachine({
      initial: "idle",
      states: {
        idle: {
          on: {
            "task.done": { target: "done" },
            "task.*": { target: "busy" },
            "*": { target: "idle" },
          },
        },
        busy: {},
        done: {},
      },
    });
    const trace = [step("idle", "task.start", "busy")];
    const another = [step("idle", "task.done", "done")];
    const wildcard = [step("idle", "noise", "idle")];

    const report = traceCoverage(machine, [trace, another, wildcard]);

    expect(
      report.handlers.map(({ event, runs, targets }) => ({ event, runs, ...targets })),
    ).toEqual([
      { event: "task.done", runs: 1, declared: ["done"], seen: ["done"], unreached: [] },
      { event: "task.*", runs: 1, declared: ["busy"], seen: ["busy"], unreached: [] },
      { event: "*", runs: 1, declared: ["idle"], seen: ["idle"], unreached: [] },
    ]);
  });

  test("an event no handler matches credits nothing", () => {
    const machine = createMachine({
      initial: "a",
      states: { a: { on: { go: { target: "b" } } }, b: {} },
    });

    const report = traceCoverage(machine, [[step("b", "go", "b")]]);

    expect(report.handlers[0]!.runs).toBe(0);
    expect(report.states).toEqual([
      { state: "a", runs: 0 },
      { state: "b", runs: 1 },
    ]);
  });

  test("a run that never leaves its initial state visits it", () => {
    const machine = createMachine({
      initial: "a",
      states: { a: { on: { go: { target: "b" } } }, b: {} },
    });

    const report = traceCoverage(machine, [[step("a", "@xstate.init", "a")]]);

    expect(report.states).toEqual([
      { state: "a", runs: 1 },
      { state: "b", runs: 0 },
    ]);
    expect(report.unvisitedHandlers).toEqual([{ state: "a", event: "go" }]);
  });

  test("ignored steps credit no handler", () => {
    const machine = createMachine({
      initial: "a",
      states: { a: { on: { go: { target: "b" } } }, b: {} },
    });

    const report = traceCoverage(machine, [[{ ...step("a", "go", "a"), ignored: true }]]);

    expect(report.unvisitedHandlers).toEqual([{ state: "a", event: "go" }]);
    expect(report.unvisitedStates).toEqual(["b"]);
  });

  test("parallel regions credit each region's handler once per step", () => {
    const machine = createMachine({
      initial: "p",
      states: {
        p: {
          type: "parallel",
          on: { reset: { target: "p" } },
          states: {
            left: {
              initial: "one",
              states: { one: { on: { next: { target: "two" } } }, two: {} },
            },
            right: {
              initial: "x",
              on: { next: { target: ".y" } },
              states: { x: {}, y: {} },
            },
          },
        },
      },
    });
    const trace = [
      step({ p: { left: "one", right: "x" } }, "next", { p: { left: "two", right: "y" } }),
      step({ p: { left: "two", right: "y" } }, "reset", { p: { left: "one", right: "x" } }),
    ];

    const report = traceCoverage(machine, [trace]);

    expect(report.states.map((row) => row.state)).toEqual([
      "p.left.one",
      "p.left.two",
      "p.right.x",
      "p.right.y",
    ]);
    expect(report.unvisitedStates).toEqual([]);
    expect(report.handlers).toEqual([
      {
        state: "p",
        event: "reset",
        runs: 1,
        targets: { declared: ["p"], seen: ["p.left.one", "p.right.x"], unreached: [] },
      },
      {
        state: "p.left.one",
        event: "next",
        runs: 1,
        targets: {
          declared: ["p.left.two"],
          seen: ["p.left.two", "p.right.y"],
          unreached: [],
        },
      },
      {
        state: "p.right",
        event: "next",
        runs: 1,
        targets: {
          declared: ["p.right.y"],
          seen: ["p.left.two", "p.right.y"],
          unreached: [],
        },
      },
    ]);
  });

  test("invoke onDone/onError and after are keyed by bare event types", async () => {
    const machine = createMachine({
      initial: "outer",
      states: {
        outer: {
          invoke: { src: createAsyncLogic({ run: async () => 1 }), onDone: { target: "done" } },
          initial: "inner",
          states: {
            inner: {
              invoke: {
                src: createAsyncLogic({ run: () => new Promise<never>(() => {}) }),
                onDone: { target: "#stuck" },
                onError: { target: "#failed" },
              },
              after: { 60_000: { target: "#failed" } },
            },
          },
        },
        stuck: { id: "stuck" },
        failed: { id: "failed" },
        done: { type: "final" },
      },
    });
    const trace: AgentTraceEvent[] = [];
    const actor = createActor(machine, { inspect: traceTransitions((event) => trace.push(event)) });
    actor.start();
    await toPromise(actor);

    const report = traceCoverage(machine, [trace]);

    expect(report.handlers.map(({ state, event, runs }) => ({ state, event, runs }))).toEqual([
      { state: "outer", event: "xstate.done.actor", runs: 1 },
      { state: "outer.inner", event: "xstate.done.actor", runs: 0 },
      { state: "outer.inner", event: "xstate.error.actor", runs: 0 },
      { state: "outer.inner", event: "xstate.after", runs: 0 },
    ]);
  });

  test("a function transition declares `dynamic` targets", () => {
    const machine = createMachine({
      initial: "a",
      states: {
        a: { on: { go: () => ({ target: "b" }), stay: { target: "a" } } },
        b: {},
      },
    });

    const report = traceCoverage(machine, [[step("a", "go", "b")]]);

    expect(report.handlers.map(({ event, targets }) => ({ event, ...targets }))).toEqual([
      { event: "go", declared: "dynamic", seen: ["b"], unreached: [] },
      { event: "stay", declared: ["a"], seen: [], unreached: ["a"] },
    ]);
  });

  test("`always` handlers are unobservable, not unvisited", () => {
    const machine = createMachine({
      initial: "check",
      states: {
        check: { always: { target: "done" } },
        done: { type: "final" },
      },
    });

    const report = traceCoverage(machine, []);

    expect(report.unobservable).toEqual([{ state: "check", event: "always" }]);
    expect(report.handlers).toEqual([]);
    expect(report.unvisitedHandlers).toEqual([]);
    expect(report.ratio.handlers).toBe(1);
  });

  test("`reachable` drops unreached states from the denominator", async () => {
    const machine = createMachine({
      schemas: { events: { go: z.object({}), stop: z.object({}) } },
      initial: "a",
      states: {
        a: { on: { go: { target: "b" }, stop: { target: "c" } } },
        b: {},
        c: {},
        orphan: {},
      },
    });

    const report = traceCoverage(machine, [[step("a", "go", "b")]], {
      reachable: await explorePaths(machine),
    });

    expect(report.unreachable).toEqual(["orphan"]);
    expect(report.unvisitedStates).toEqual(["c"]);
    expect(report.ratio.states).toBe(2 / 3);
    expect(traceCoverage(machine, []).unreachable).toBeUndefined();
  });

  test("serialized traces give the same report", async () => {
    const traces = [await run("refund"), await run("escalate")];
    const json = traces.map((trace) =>
      trace.map((event) => JSON.parse(JSON.stringify(serializeTraceEvent(event)))),
    );

    expect(traceCoverage(desk, json)).toEqual(traceCoverage(desk, traces));
  });

  test("no traces leave everything unvisited", () => {
    const report = traceCoverage(desk, []);

    expect(report.unvisitedStates).toEqual(["deciding", "refunded", "escalated"]);
    expect(report.unvisitedHandlers).toHaveLength(2);
    expect(report.ratio).toEqual({ states: 0, handlers: 0 });
  });
});
