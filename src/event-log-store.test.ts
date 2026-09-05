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
void assertEventLogStoreConformance(createInMemoryEventLogStore, { describe, it, expect });

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
