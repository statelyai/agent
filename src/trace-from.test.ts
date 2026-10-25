import { describe, expect, test } from "vitest";
import { createActor, createAsyncLogic, createMachine, toPromise } from "xstate";
import { serializeTraceEvent, traceTransitions, type AgentTraceEvent, runAgent } from "./index.js";

const machine = createMachine({
  id: "job",
  initial: "idle",
  states: {
    idle: { on: { GO: { target: "working" } } },
    working: {
      invoke: { src: createAsyncLogic({ run: async () => 42 }), onDone: { target: "done" } },
    },
    done: { type: "final" },
  },
});

function transitions(trace: AgentTraceEvent[]) {
  return trace.flatMap((event) =>
    event.type === "machine.transition"
      ? [{ type: event.event.type, from: event.from.value, to: event.snapshot.value }]
      : [],
  );
}

describe("machine.transition `from`", () => {
  test("the runtime records the state each event arrived in", async () => {
    const trace: AgentTraceEvent[] = [];
    await runAgent(machine, { onTrace: (event) => trace.push(event), event: { type: "GO" } });

    const [init, ...rest] = transitions(trace);
    // The first transition has no earlier state: it arrives where it starts.
    expect(init).toMatchObject({ from: "idle", to: "idle" });
    expect(rest).toEqual([
      { type: "GO", from: "idle", to: "working" },
      { type: "xstate.done.actor", from: "working", to: "done" },
    ]);
  });

  test("traceTransitions records it for a plain actor", async () => {
    const trace: AgentTraceEvent[] = [];
    const actor = createActor(machine, { inspect: traceTransitions((event) => trace.push(event)) });
    actor.start();
    actor.send({ type: "GO" });
    await toPromise(actor);

    const [init, ...rest] = transitions(trace);
    expect(init).toMatchObject({ from: "idle", to: "idle" });
    expect(rest).toEqual([
      { type: "GO", from: "idle", to: "working" },
      { type: "xstate.done.actor", from: "working", to: "done" },
    ]);
  });

  test("serializeTraceEvent keeps it", async () => {
    const trace: AgentTraceEvent[] = [];
    await runAgent(machine, { onTrace: (event) => trace.push(event), event: { type: "GO" } });
    const go = trace.find(
      (event) => event.type === "machine.transition" && event.event.type === "GO",
    )!;

    expect(JSON.parse(JSON.stringify(serializeTraceEvent(go)))).toMatchObject({
      from: { value: "idle" },
    });
  });
});
