import { describe, expect, test } from "vitest";
import { z } from "zod";
import { createActor, createMachine } from "xstate";
import { decideNext } from "./decide-next.js";
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
import { foldTraces } from "./testing/index.js";

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

const endedIn = (trace: readonly { type: string; snapshot?: unknown }[]) =>
  (
    [...trace].reverse().find((event) => event.type === "machine.transition")!.snapshot as {
      value: unknown;
    }
  ).value;

describe("foldTraces", () => {
  test("counts visits, failures, and withheld options per state", async () => {
    const traces = [await run("refund"), await run("escalate")];

    const stats = foldTraces(traces, { failed: (trace) => endedIn(trace) !== "refunded" });

    expect(stats).toEqual([
      { state: "deciding", visits: 2, failures: 1, withheld: 2, ignored: 0 },
      { state: "refunded", visits: 1, failures: 0, withheld: 0, ignored: 0 },
      { state: "escalated", visits: 1, failures: 1, withheld: 0, ignored: 0 },
    ]);
  });

  test("rows come back in first-visited order", () => {
    const trace = [
      { type: "machine.transition", from: { value: "idle" }, snapshot: { value: "idle" } },
      { type: "machine.transition", from: { value: "idle" }, snapshot: { value: "deciding" } },
      {
        type: "request.start",
        request: { kind: "decision", attempts: [], withheld: [{ type: "refund" }] },
      },
    ];

    expect(foldTraces([trace], { failed: () => false }).map((row) => row.state)).toEqual([
      "idle",
      "deciding",
    ]);
  });

  test("folds serialized traces the same way", async () => {
    const traces = [await run("refund"), await run("escalate")];
    const failed = (trace: readonly { type: string; snapshot?: unknown }[]) =>
      endedIn(trace) !== "refunded";
    const json = traces.map((trace) =>
      trace.map((event) => JSON.parse(JSON.stringify(serializeTraceEvent(event)))),
    );

    expect(foldTraces(json, { failed })).toEqual(foldTraces(traces, { failed }));
  });

  test("a host-driven decideNext joins the trace as its request", async () => {
    const plain = createMachine({
      context: { limit: 50 },
      schemas: { events: { refund: z.object({ amount: z.number() }) } },
      initial: "reviewing",
      states: {
        reviewing: {
          on: {
            refund: ({ context, event }) =>
              event.amount <= context.limit ? { target: "refunded" } : undefined,
          },
        },
        refunded: { type: "final" },
      },
    });
    const trace: (AgentTraceEvent | { type: "request.start"; request: unknown })[] = [];
    const actor = createActor(plain, { inspect: traceTransitions((event) => trace.push(event)) });
    actor.start();

    const result = await decideNext(actor.getSnapshot(), {
      decide: choose("refund"),
      model: "quick",
      allowedEvents: "refund",
      payloads: () => ({ refund: [{ amount: 20 }, { amount: 80 }] }),
    });
    trace.push({ type: "request.start", request: result.request });
    actor.send(result.event!);

    expect(foldTraces([trace], { failed: () => false })).toEqual([
      { state: "reviewing", visits: 1, failures: 0, withheld: 1, ignored: 0 },
      { state: "refunded", visits: 1, failures: 0, withheld: 0, ignored: 0 },
    ]);
  });

  test("counts ignored events toward the state that ignored them", () => {
    const trace = [
      { type: "machine.transition", from: { value: "idle" }, snapshot: { value: "waiting" } },
      {
        type: "machine.transition",
        from: { value: "waiting" },
        snapshot: { value: "waiting" },
        ignored: true,
      },
    ];

    expect(foldTraces([trace, trace], { failed: () => false })).toEqual([
      { state: "idle", visits: 2, failures: 0, withheld: 0, ignored: 0 },
      { state: "waiting", visits: 2, failures: 0, withheld: 0, ignored: 2 },
    ]);
  });

  test("nested and parallel states count by leaf path", () => {
    const trace = [
      {
        type: "machine.transition",
        from: { value: { work: { a: "one", b: "two" } } },
        snapshot: { value: { work: { a: "one", b: "two" } } },
      },
    ];

    expect(foldTraces([trace], { failed: () => true }).map((stat) => stat.state)).toEqual([
      "work.a.one",
      "work.b.two",
    ]);
  });
});
