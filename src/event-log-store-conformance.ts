/**
 * The runner-agnostic conformance suite for {@link AgentEventLogStore}
 * implementations. Split out of `event-log-store.ts` so the store contract and
 * the reference implementation stay readable; re-exported from there (and from
 * the package root) so the public surface is unchanged.
 * @module
 */
import {
  AGENT_EVENT_SCHEMA_VERSION,
  AgentEventLogConflictError,
  type AgentEventLogStore,
  type AgentLogEntry,
  type JsonValue,
} from "./event-log-store.js";

// Runner-agnostic: a plain async function that throws a descriptive Error on
// the first violation, so any test runner (or a plain script) can drive it
// against its own store. One tier — fork/read/length are cheap enough to be
// core, so this protocol has no optional capabilities.

/** Produces a fresh, empty store for one assertion. */
type CreateStore = () => Promise<AgentEventLogStore> | AgentEventLogStore;

function fail(message: string): never {
  throw new Error(`event-log-store conformance: ${message}`);
}

function entry(index: number, type: string, metadata?: Record<string, JsonValue>): AgentLogEntry {
  return {
    schemaVersion: AGENT_EVENT_SCHEMA_VERSION,
    id: `evt_${index}`,
    index,
    recordedAt: "2026-01-01T00:00:00.000Z",
    machineId: "conformance",
    machineVersion: "v1",
    event: { type, seq: index },
    ...(metadata !== undefined ? { metadata } : {}),
  } as AgentLogEntry;
}

function entriesFrom(start: number, count: number): AgentLogEntry[] {
  return Array.from({ length: count }, (_unused, i) => entry(start + i, `e${start + i}`));
}

function assertJsonEqual(actual: unknown, expected: unknown, message: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    fail(`${message} (expected ${b}, got ${a})`);
  }
}

/**
 * Validates a store against the reference's semantics: empty read + zero length
 * for unknown threads; single and multi-entry append; contiguity misuse guard;
 * stale-`expectedIndex` conflict with correct fields; an interleaved concurrent
 * append race (exactly one winner); event-id uniqueness; `read({ from })`
 * incremental correctness; thread isolation; metadata round-trip; deep-copy
 * isolation on append and read; and the full fork contract.
 */
export async function assertEventLogStoreConformance(create: CreateStore): Promise<void> {
  // Unknown thread → empty read, zero length.
  {
    const store = await create();
    assertJsonEqual(await store.read("missing"), [], "read of an unknown thread must be empty");
    if ((await store.length("missing")) !== 0) {
      fail("length of an unknown thread must be 0");
    }
  }

  // Single-entry append + read-back + length.
  {
    const store = await create();
    const e = entry(0, "start", { label: "first" });
    await store.append({ threadId: "t", expectedIndex: 0, entries: [e] });
    assertJsonEqual(await store.read("t"), [e], "read must return the appended entry");
    if ((await store.length("t")) !== 1) {
      fail("length after a single append must be 1");
    }
  }

  // Multi-entry append, then a second append that extends the log.
  {
    const store = await create();
    await store.append({ threadId: "t", expectedIndex: 0, entries: entriesFrom(0, 3) });
    await store.append({ threadId: "t", expectedIndex: 3, entries: entriesFrom(3, 2) });
    if ((await store.length("t")) !== 5) {
      fail("length after appending 3 then 2 entries must be 5");
    }
    assertJsonEqual(
      (await store.read("t")).map((e) => e.index),
      [0, 1, 2, 3, 4],
      "reads must return entries in contiguous log order",
    );
  }

  // Contiguity: a non-contiguous entry.index is misuse, not a race.
  {
    const store = await create();
    let caught: unknown;
    try {
      // expectedIndex 0 but entry.index 1: a hole.
      await store.append({ threadId: "t", expectedIndex: 0, entries: [entry(1, "gap")] });
    } catch (error) {
      caught = error;
    }
    if (!(caught instanceof Error) || caught instanceof AgentEventLogConflictError) {
      fail("a non-contiguous entry.index must throw a plain Error, not a conflict");
    }
  }

  // Stale expectedIndex → conflict with correct fields.
  {
    const store = await create();
    await store.append({ threadId: "t", expectedIndex: 0, entries: [entry(0, "a")] });
    let caught: unknown;
    try {
      // expectedIndex 0 is stale (length is 1); entry.index 0 clears the contiguity guard.
      await store.append({ threadId: "t", expectedIndex: 0, entries: [entry(0, "b")] });
    } catch (error) {
      caught = error;
    }
    if (!(caught instanceof AgentEventLogConflictError)) {
      fail("a stale expectedIndex must throw AgentEventLogConflictError");
    }
    if (caught.threadId !== "t" || caught.expectedIndex !== 0 || caught.actualIndex !== 1) {
      fail("conflict error must carry threadId, expectedIndex, and the actual index");
    }
  }

  // Event identity is unique within a thread.
  {
    const store = await create();
    await store.append({ threadId: "t", expectedIndex: 0, entries: [entry(0, "a")] });
    let caught: unknown;
    try {
      await store.append({
        threadId: "t",
        expectedIndex: 1,
        entries: [{ ...entry(1, "b"), id: "evt_0" }],
      });
    } catch (error) {
      caught = error;
    }
    if (!(caught instanceof Error) || caught instanceof AgentEventLogConflictError) {
      fail("a duplicate event id within a thread must throw a plain Error");
    }
  }

  // Concurrent append race: two writers hold length 1, both append at index 1.
  {
    const store = await create();
    await store.append({ threadId: "t", expectedIndex: 0, entries: [entry(0, "a")] });
    const results = await Promise.allSettled([
      store.append({ threadId: "t", expectedIndex: 1, entries: [entry(1, "w-a")] }),
      store.append({ threadId: "t", expectedIndex: 1, entries: [entry(1, "w-b")] }),
    ]);
    const winners = results.filter((r) => r.status === "fulfilled");
    const conflicts = results.filter(
      (r) => r.status === "rejected" && r.reason instanceof AgentEventLogConflictError,
    );
    if (winners.length !== 1) {
      fail(`exactly one racing append must win, got ${winners.length}`);
    }
    if (conflicts.length !== 1) {
      fail(`exactly one racing append must reject with a conflict, got ${conflicts.length}`);
    }
    if ((await store.length("t")) !== 2) {
      fail("after the race the log length must be 2");
    }
  }

  // read({ from }) incremental correctness.
  {
    const store = await create();
    await store.append({ threadId: "t", expectedIndex: 0, entries: entriesFrom(0, 5) });
    assertJsonEqual(
      (await store.read("t", { from: 2 })).map((e) => e.index),
      [2, 3, 4],
      "read({ from }) must skip entries below `from`",
    );
    assertJsonEqual(
      await store.read("t", { from: 5 }),
      [],
      "read({ from }) at the log length must be empty",
    );
  }

  // Thread isolation.
  {
    const store = await create();
    await store.append({ threadId: "a", expectedIndex: 0, entries: [entry(0, "x")] });
    if ((await store.length("b")) !== 0) {
      fail("an append to one thread must not create another");
    }
    await store.append({ threadId: "b", expectedIndex: 0, entries: entriesFrom(0, 2) });
    if ((await store.length("a")) !== 1 || (await store.length("b")) !== 2) {
      fail("threads must grow independently");
    }
  }

  // Metadata round-trip.
  {
    const store = await create();
    const metadata = { source: "user", nested: { attempt: 2 }, tags: ["x", "y"] };
    await store.append({ threadId: "t", expectedIndex: 0, entries: [entry(0, "e", metadata)] });
    assertJsonEqual(
      (await store.read("t"))[0]!.metadata,
      metadata,
      "metadata must round-trip verbatim",
    );
  }

  // Deep-copy isolation: mutating an appended value or a read value must not
  // change stored state.
  {
    const store = await create();
    const e = entry(0, "e", { tags: ["a"] });
    await store.append({ threadId: "t", expectedIndex: 0, entries: [e] });
    (e.metadata!.tags as string[]).push("mutated-after-append");
    (e.event as { type: string; seq: number }).seq = 999;

    const read = await store.read("t");
    (read[0]!.metadata!.tags as string[]).push("mutated-after-read");
    (read[0]!.event as { type: string; seq: number }).seq = 888;

    const reread = await store.read("t");
    assertJsonEqual(
      reread[0]!.metadata,
      { tags: ["a"] },
      "stored entry must be isolated from post-append and post-read mutation",
    );
    assertJsonEqual(
      reread[0]!.event,
      { type: "e", seq: 0 },
      "stored event must be isolated from mutation of an appended or read copy",
    );
  }

  // Fork: full prefix, partial prefix, independent append, source untouched,
  // and the rejection cases.
  {
    const store = await create();
    await store.append({ threadId: "src", expectedIndex: 0, entries: entriesFrom(0, 3) });

    // Full prefix (default upToIndex).
    await store.fork({ threadId: "src", newThreadId: "fork-full" });
    if ((await store.length("fork-full")) !== 3) {
      fail("fork with the default upToIndex must copy the full log");
    }

    // Partial prefix.
    await store.fork({ threadId: "src", newThreadId: "fork-1", upToIndex: 1 });
    assertJsonEqual(
      (await store.read("fork-1")).map((e) => e.index),
      [0],
      "fork with upToIndex 1 must copy only entry 0",
    );

    // upToIndex is exclusive.
    await store.fork({ threadId: "src", newThreadId: "fork-2", upToIndex: 2 });
    assertJsonEqual(
      (await store.read("fork-2")).map((e) => e.id),
      ["evt_0", "evt_1"],
      "fork with upToIndex 2 must copy entries 0 and 1 only",
    );

    // The fork appends independently from its copied length; the source is untouched.
    await store.append({ threadId: "fork-1", expectedIndex: 1, entries: [entry(1, "branch")] });
    assertJsonEqual(
      (await store.read("fork-1")).map((e) => (e.event as { type: string }).type),
      ["e0", "branch"],
      "a forked thread must append independently from its copied length",
    );
    if ((await store.length("src")) !== 3) {
      fail("appending to a fork must not touch the source thread");
    }

    // Fork onto a thread that already has entries rejects.
    let caughtExisting: unknown;
    try {
      await store.fork({ threadId: "src", newThreadId: "fork-full" });
    } catch (error) {
      caughtExisting = error;
    }
    if (
      !(caughtExisting instanceof Error) ||
      caughtExisting instanceof AgentEventLogConflictError
    ) {
      fail("forking onto a non-empty thread must reject with a plain Error");
    }

    // Fork of an unknown source rejects.
    let caughtUnknown: unknown;
    try {
      await store.fork({ threadId: "nope", newThreadId: "fork-nope" });
    } catch (error) {
      caughtUnknown = error;
    }
    if (!(caughtUnknown instanceof Error) || caughtUnknown instanceof AgentEventLogConflictError) {
      fail("forking an unknown source thread must reject with a plain Error");
    }

    // An out-of-range upToIndex rejects.
    let caughtRange: unknown;
    try {
      await store.fork({ threadId: "src", newThreadId: "fork-range", upToIndex: 99 });
    } catch (error) {
      caughtRange = error;
    }
    if (!(caughtRange instanceof Error) || caughtRange instanceof AgentEventLogConflictError) {
      fail("forking past the source length must reject with a plain Error");
    }
  }
}
