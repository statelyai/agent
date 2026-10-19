import { describe, expect, it, test } from "vitest";
import { AGENT_EVENT_SCHEMA_VERSION, type AgentLogEntry } from "./event-log.js";
import { AgentEventLogConflictError, createInMemoryEventLogStore } from "./event-log-store.js";
import { assertEventLogStoreConformance } from "./event-log-store-conformance.js";

function testEntry(index: number, type: string): AgentLogEntry {
  return {
    schemaVersion: AGENT_EVENT_SCHEMA_VERSION,
    id: `evt_${index}`,
    index,
    recordedAt: "2026-01-01T00:00:00.000Z",
    machineId: "test",
    machineVersion: "v1",
    event: { type },
  };
}

// The harness form: each conformance case becomes its own test.
void assertEventLogStoreConformance(createInMemoryEventLogStore, { describe, it });

describe("createInMemoryEventLogStore", () => {
  test("passes the conformance suite in its runner-agnostic form", async () => {
    await expect(
      assertEventLogStoreConformance(createInMemoryEventLogStore),
    ).resolves.toBeUndefined();
  });

  test("a stale expectedIndex throws AgentEventLogConflictError with both indices", async () => {
    const store = createInMemoryEventLogStore();
    await store.append({ threadId: "t", expectedIndex: 0, entries: [testEntry(0, "a")] });

    let caught: unknown;
    try {
      await store.append({ threadId: "t", expectedIndex: 0, entries: [testEntry(0, "b")] });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AgentEventLogConflictError);
    const conflict = caught as AgentEventLogConflictError;
    expect(conflict.code).toBe("event-log-conflict");
    expect(conflict.threadId).toBe("t");
    expect(conflict.expectedIndex).toBe(0);
    expect(conflict.actualIndex).toBe(1);
    expect(conflict.name).toBe("AgentEventLogConflictError");
  });

  test("fork rejects upToIndex 0, which would drop the init entry", async () => {
    const store = createInMemoryEventLogStore();
    await store.append({ threadId: "t", expectedIndex: 0, entries: [testEntry(0, "a")] });

    await expect(
      store.fork({ threadId: "t", newThreadId: "f", upToIndex: 0 }),
    ).rejects.toThrowError(/upToIndex must be an integer in \[1, 1\]/);
    expect(await store.length("f")).toBe(0);
  });

  test("rejects an entry that is not a valid envelope", async () => {
    const store = createInMemoryEventLogStore();

    await expect(
      store.append({
        threadId: "t",
        expectedIndex: 0,
        entries: [{ ...testEntry(0, "a"), recordedAt: "yesterday" }],
      }),
    ).rejects.toThrowError(/RFC 3339/);
  });
});

describe("createInMemoryEventLogStore listThreads", () => {
  async function storeWith(threadIds: string[]) {
    const store = createInMemoryEventLogStore();
    for (const threadId of threadIds) {
      await store.append({ threadId, expectedIndex: 0, entries: [testEntry(0, "start")] });
    }
    return store;
  }

  test("lists non-empty threads sorted, with no cursor when nothing remains", async () => {
    const store = await storeWith(["b", "a", "c"]);
    await store.fork({ threadId: "a", newThreadId: "a-fork" });
    expect(await store.listThreads!()).toEqual({ threadIds: ["a", "a-fork", "b", "c"] });
  });

  test("filters by prefix", async () => {
    const store = await storeWith(["refunds:1", "refunds:2", "billing:1"]);
    expect((await store.listThreads!({ prefix: "refunds:" })).threadIds).toEqual([
      "refunds:1",
      "refunds:2",
    ]);
    expect((await store.listThreads!({ prefix: "nope" })).threadIds).toEqual([]);
  });

  test("pages with limit and cursor", async () => {
    const store = await storeWith(["t1", "t2", "t3", "t4", "t5"]);
    const first = await store.listThreads!({ limit: 2 });
    expect(first.threadIds).toEqual(["t1", "t2"]);
    const second = await store.listThreads!({ limit: 2, cursor: first.cursor });
    expect(second.threadIds).toEqual(["t3", "t4"]);
    const third = await store.listThreads!({ limit: 2, cursor: second.cursor });
    expect(third).toEqual({ threadIds: ["t5"] });
  });

  test("a thread appended after a page was read still shows up on a later page", async () => {
    const store = await storeWith(["a", "c"]);
    const first = await store.listThreads!({ limit: 1 });
    await store.append({ threadId: "b", expectedIndex: 0, entries: [testEntry(0, "start")] });
    expect((await store.listThreads!({ cursor: first.cursor })).threadIds).toEqual(["b", "c"]);
  });

  test("rejects a non-positive or fractional limit", async () => {
    const store = await storeWith(["a"]);
    await expect(store.listThreads!({ limit: 0 })).rejects.toThrowError(/positive integer/);
    await expect(store.listThreads!({ limit: 1.5 })).rejects.toThrowError(/positive integer/);
  });

  test("conformance passes for a store without the optional listThreads", async () => {
    const withoutListThreads = () => {
      const { listThreads: _listThreads, ...rest } = createInMemoryEventLogStore();
      return rest;
    };
    await expect(assertEventLogStoreConformance(withoutListThreads)).resolves.toBeUndefined();
  });

  test("conformance fails a listThreads that ignores limit", async () => {
    const ignoresLimit = () => {
      const store = createInMemoryEventLogStore();
      return { ...store, listThreads: () => store.listThreads!() };
    };
    await expect(assertEventLogStoreConformance(ignoresLimit)).rejects.toThrowError(
      /must honor limit 2/,
    );
  });
});
