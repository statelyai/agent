import { describe, expect, test } from "vitest";
import { createActor, createAsyncLogic, createMachine, toPromise } from "xstate";
import { z } from "zod";
import { AgentEventLogError, recordLog, replay } from "./log/index.js";

function setup() {
  let lookups = 0;
  const machine = createMachine({
    id: "order",
    schemas: { input: z.object({ orderId: z.string() }) },
    context: ({ input }) => ({ orderId: input.orderId, total: 0 }),
    initial: "idle",
    states: {
      idle: { on: { LOOKUP: { target: "looking" } } },
      looking: {
        invoke: {
          src: createAsyncLogic({
            run: async () => {
              lookups++;
              return 42;
            },
          }),
          onDone: ({ context, event }) => ({
            target: "found",
            context: { ...context, total: event.output as number },
          }),
        },
      },
      found: { type: "final" },
    },
  });
  return { machine, lookups: () => lookups };
}

describe("recordLog", () => {
  test("records a plain createActor run that replay folds with no actors executed", async () => {
    const { machine, lookups } = setup();
    const actor = createActor(machine, { input: { orderId: "o1" } });
    const log = recordLog(actor);
    actor.start();
    actor.send({ type: "LOOKUP" });
    await toPromise(actor);
    log.stop();

    expect(log.entries.map((entry) => entry.event.type)).toEqual([
      "@agent.init",
      "LOOKUP",
      "xstate.done.actor",
    ]);
    expect(lookups()).toBe(1);

    const { snapshot } = replay(machine, log.entries);
    expect(snapshot.value).toBe(actor.getSnapshot().value);
    expect(snapshot.context).toEqual({ orderId: "o1", total: 42 });
    expect(lookups()).toBe(1);
  });

  test("an actor restored from a snapshot starts its log from that snapshot", () => {
    const { machine } = setup();
    const first = createActor(machine, { input: { orderId: "o1" } }).start();
    const persisted = first.getPersistedSnapshot();
    first.stop();

    const actor = createActor(machine, { snapshot: persisted });
    const log = recordLog(actor);
    actor.start();
    actor.send({ type: "LOOKUP" });
    actor.stop();

    expect(log.entries[0]!.event).toMatchObject({
      type: "@agent.init",
      snapshot: { value: "idle" },
    });
    expect(replay(machine, log.entries).snapshot.value).toBe("looking");
  });

  test("attaching after start is an error, not a silent partial log", () => {
    const { machine } = setup();
    const actor = createActor(machine, { input: { orderId: "o1" } });
    actor.start();
    const log = recordLog(actor);
    actor.send({ type: "LOOKUP" });

    expect(() => log.entries).toThrow(AgentEventLogError);
  });

  test("attaching after start errors even before the next transition", () => {
    const { machine } = setup();
    const actor = createActor(machine, { input: { orderId: "o1" } });
    actor.start();
    const log = recordLog(actor);

    expect(() => log.entries).toThrow(AgentEventLogError);
  });

  test("attaching to a finished actor throws at once", async () => {
    const { machine } = setup();
    const actor = createActor(machine, { input: { orderId: "o1" } });
    actor.start();
    actor.send({ type: "LOOKUP" });
    await toPromise(actor);

    expect(() => recordLog(actor)).toThrow(AgentEventLogError);
  });
});
