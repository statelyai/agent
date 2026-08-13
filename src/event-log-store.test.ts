import { describe, expect, test } from "vitest";
import { z } from "zod";
import { createActor, setup, type EventFromLogic } from "xstate";
import { createReplayEntry, initEntry, replay } from "./effects.js";
import {
  AgentEventLogConflictError,
  NonSerializableAgentEventError,
  assertAgentLogEntry,
  assertEventLogStoreConformance,
  createInMemoryEventLogStore,
  type AgentLogEntry,
} from "./event-log-store.js";

function testEntry(index: number, type: string): AgentLogEntry {
  return {
    schemaVersion: 1,
    id: `evt_${index}`,
    index,
    recordedAt: "2026-01-01T00:00:00.000Z",
    machineId: "test",
    machineVersion: "v1",
    event: { type },
  };
}

describe("createInMemoryEventLogStore conformance", () => {
  test("passes the full conformance suite", async () => {
    await expect(
      assertEventLogStoreConformance(createInMemoryEventLogStore),
    ).resolves.toBeUndefined();
  });
});

describe("AgentEventLogConflictError", () => {
  test("carries threadId, expectedIndex, and actualIndex", async () => {
    const store = createInMemoryEventLogStore();
    await store.append({
      threadId: "t",
      expectedIndex: 0,
      entries: [testEntry(0, "a")],
    });

    let caught: unknown;
    try {
      await store.append({
        threadId: "t",
        expectedIndex: 0,
        entries: [testEntry(0, "b")],
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AgentEventLogConflictError);
    const conflict = caught as AgentEventLogConflictError;
    expect(conflict.threadId).toBe("t");
    expect(conflict.expectedIndex).toBe(0);
    expect(conflict.actualIndex).toBe(1);
    expect(conflict.name).toBe("AgentEventLogConflictError");
  });
});

describe("JSON validation", () => {
  test("rejects values that JSON would drop or coerce, with the exact path", async () => {
    const store = createInMemoryEventLogStore();
    const invalid = {
      ...testEntry(0, "BROKEN"),
      event: { type: "BROKEN", output: { createdAt: new Date() } },
    } as unknown as AgentLogEntry;

    await expect(
      store.append({ threadId: "t", expectedIndex: 0, entries: [invalid] }),
    ).rejects.toMatchObject({
      name: "NonSerializableAgentEventError",
      path: "entry.event.output.createdAt",
      valueType: "Date",
    });
    await expect(
      store.append({
        threadId: "t",
        expectedIndex: 0,
        entries: [
          {
            ...testEntry(0, "BROKEN"),
            event: { type: "BROKEN", value: undefined },
          } as unknown as AgentLogEntry,
        ],
      }),
    ).rejects.toBeInstanceOf(NonSerializableAgentEventError);
  });

  test("validates the envelope shape and RFC 3339 timestamp", () => {
    expect(() => assertAgentLogEntry({ ...testEntry(0, "OK"), recordedAt: "yesterday" })).toThrow(
      /RFC 3339/,
    );
    expect(() => assertAgentLogEntry({ ...testEntry(0, "OK"), event: { type: "" } })).toThrow(
      /event.*type/,
    );
  });

  test("rejects sparse arrays and hidden fields that JSON would silently coerce", () => {
    const sparse = Object.assign([] as string[], { 0: "first", 2: "third", length: 3 });
    expect(() =>
      assertAgentLogEntry({ ...testEntry(0, "SPARSE"), event: { type: "SPARSE", sparse } }),
    ).toThrow(NonSerializableAgentEventError);

    const event = { type: "HIDDEN" };
    Object.defineProperty(event, "hidden", { value: true, enumerable: false });
    expect(() => assertAgentLogEntry({ ...testEntry(0, "HIDDEN"), event })).toThrow(
      NonSerializableAgentEventError,
    );
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

    const first = initEntry(counterMachine);
    await store.append({ threadId, expectedIndex: 0, entries: [first] });
    for (const event of externalEvents) {
      const prefix = await store.read(threadId);
      const entry = createReplayEntry(counterMachine, prefix, event);
      await store.append({ threadId, expectedIndex: prefix.length, entries: [entry] });
      actor.send(event);
    }

    const liveSnapshot = actor.getSnapshot();

    // ── "Fresh process": rebuild purely from the log via pure transitions.
    const journal: AgentLogEntry[] = await store.read(threadId);
    const { snapshot } = replay(counterMachine, journal);

    // The deterministic-replay property the whole durability model rests on.
    const toJson = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown;
    expect(toJson(snapshot)).toEqual(toJson(liveSnapshot));
    expect(snapshot.context).toEqual({ total: 17, ops: 3 });
    expect(snapshot.status).toBe("done");
  });
});
