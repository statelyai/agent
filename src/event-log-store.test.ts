import { describe, expect, test } from "vitest";
import { z } from "zod";
import { createActor, initialTransition, setup, transition, type EventFromLogic } from "xstate";
import { persistSnapshot } from "./utils.js";
import {
  AgentEventLogConflictError,
  assertEventLogStoreConformance,
  createInMemoryEventLogStore,
  type AgentLogEntry,
} from "./event-log-store.js";

describe("createInMemoryEventLogStore conformance", () => {
  test("passes the full conformance suite", async () => {
    await expect(
      assertEventLogStoreConformance(createInMemoryEventLogStore),
    ).resolves.toBeUndefined();
  });
});

describe("AgentEventLogConflictError", () => {
  test("carries threadId, expectedIndex, and actualLength", async () => {
    const store = createInMemoryEventLogStore();
    await store.append({
      threadId: "t",
      expectedIndex: 0,
      entries: [{ index: 0, event: { type: "a" } }],
    });

    let caught: unknown;
    try {
      await store.append({
        threadId: "t",
        expectedIndex: 0,
        entries: [{ index: 0, event: { type: "b" } }],
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AgentEventLogConflictError);
    const conflict = caught as AgentEventLogConflictError;
    expect(conflict.threadId).toBe("t");
    expect(conflict.expectedIndex).toBe(0);
    expect(conflict.actualLength).toBe(1);
    expect(conflict.name).toBe("AgentEventLogConflictError");
  });
});

describe("deterministic replay from the log", () => {
  // A plain, deterministic machine — no model calls, no invoked actors. Its
  // external inputs are the user-sent ADD / SCALE / DONE events; replaying just
  // those through xstate's pure `transition` must reconstruct the live snapshot.
  const counterMachine = setup({
    schemas: {
      context: z.object({ total: z.number(), ops: z.number() }),
      events: {
        ADD: z.object({ amount: z.number() }),
        SCALE: z.object({ factor: z.number() }),
        DONE: z.object({}),
      },
    },
  }).createMachine({
    id: "counter",
    initial: "counting",
    context: { total: 0, ops: 0 },
    states: {
      counting: {
        on: {
          ADD: {
            context: ({ context, event }) => ({
              total: context.total + event.amount,
              ops: context.ops + 1,
            }),
          },
          SCALE: {
            context: ({ context, event }) => ({
              total: context.total * event.factor,
              ops: context.ops + 1,
            }),
          },
          DONE: { target: "done" },
        },
      },
      done: { type: "final" },
    },
  });

  test("folding the journaled external events reconstructs the live final snapshot", async () => {
    const store = createInMemoryEventLogStore();
    const threadId = "replay-thread";

    // ── Live run: drive the actor, journaling each external event as it happens.
    const actor = createActor(counterMachine).start();
    const externalEvents: EventFromLogic<typeof counterMachine>[] = [
      { type: "ADD", amount: 5 },
      { type: "SCALE", factor: 3 },
      { type: "ADD", amount: 2 },
      { type: "DONE" },
    ];

    for (const event of externalEvents) {
      const index = await store.length(threadId);
      await store.append({ threadId, expectedIndex: index, entries: [{ index, event }] });
      actor.send(event);
    }

    const liveSnapshot = actor.getSnapshot();

    // ── "Fresh process": rebuild purely from the log via pure transitions.
    const journal: AgentLogEntry[] = await store.read(threadId);
    let [snapshot] = initialTransition(counterMachine);
    for (const logEntry of journal) {
      [snapshot] = transition(counterMachine, snapshot, logEntry.event as never);
    }

    // The deterministic-replay property the whole durability model rests on.
    expect(persistSnapshot(snapshot)).toEqual(persistSnapshot(liveSnapshot));
    expect(snapshot.context).toEqual({ total: 17, ops: 3 });
    expect(snapshot.status).toBe("done");
  });
});
