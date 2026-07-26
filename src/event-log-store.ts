import type { EventObject } from "xstate";

/**
 * One journaled entry: an EXTERNAL input to the machine — an effect completion
 * (a `done`/`error` event carrying its output inline), a user-sent event, or a
 * timer firing. Never a raised/internal event: deterministic replay re-derives
 * those from the machine's own logic, so journaling them would double-apply.
 * JSON-safe, stored verbatim.
 */
export interface AgentLogEntry {
  /** 0-based position in the thread's log. */
  index: number;
  event: EventObject;
  /** Host-owned, JSON-safe; stored verbatim, never interpreted. */
  metadata?: Record<string, unknown>;
}

/**
 * An append-only event log: the authoritative durability artifact of a thread.
 * The journal of external inputs IS the source of truth — deterministic machine
 * replay derives every snapshot from it, a fork is a copied log prefix, and the
 * type-only {@link AgentSnapshotStore} is a mere idle-point compaction cache
 * over what the log already implies.
 *
 * Userland stores (a Postgres table with a `(thread_id, index)` primary key, an
 * append-only object in blob storage, …) implement this one shape so they
 * interoperate; {@link createInMemoryEventLogStore} is the in-memory reference.
 */
export interface AgentEventLogStore {
  /**
   * Append `entries` starting at `expectedIndex` (the current length of the
   * thread's log; 0 for a new thread). Atomic — all entries land or none do.
   * Rejects with {@link AgentEventLogConflictError} when the thread's length
   * differs from `expectedIndex`: a concurrent writer appended first. Each
   * entry's `index` must be contiguous from `expectedIndex` (a plain `Error`
   * otherwise: that is caller misuse, not a race).
   */
  append(input: {
    threadId: string;
    expectedIndex: number;
    entries: AgentLogEntry[];
  }): Promise<void>;
  /**
   * Read a thread's entries in log order. `from` (default 0) skips entries
   * below that index for incremental catch-up. An unknown thread reads as an
   * empty array.
   */
  read(threadId: string, options?: { from?: number }): Promise<AgentLogEntry[]>;
  /** The thread's current log length (0 for an unknown thread) — the next `expectedIndex`. */
  length(threadId: string): Promise<number>;
  /**
   * Copy entries `[0, upToIndex)` onto a fresh, empty `newThreadId` — a fork
   * point for time travel or a divergent branch, which then appends
   * independently of the source. `upToIndex` defaults to the source's full
   * length. Rejects (plain `Error`) if `newThreadId` already has entries, or if
   * the source is unknown. Implementations may copy-on-write or physically
   * copy; observable behavior must match a full copy.
   */
  fork(input: { threadId: string; newThreadId: string; upToIndex?: number }): Promise<void>;
}

/**
 * Rejection from {@link AgentEventLogStore.append} when the thread's stored
 * length is not the `expectedIndex` the writer held — a concurrent writer
 * appended first. `actualLength` is the length core found.
 */
export class AgentEventLogConflictError extends Error {
  readonly threadId: string;
  readonly expectedIndex: number;
  readonly actualLength: number;

  constructor(threadId: string, expectedIndex: number, actualLength: number) {
    super(
      `AgentEventLogStore.append: length conflict on thread "${threadId}": ` +
        `expected length ${expectedIndex} but found ${actualLength} — a concurrent writer won.`,
    );
    this.name = "AgentEventLogConflictError";
    this.threadId = threadId;
    this.expectedIndex = expectedIndex;
    this.actualLength = actualLength;
  }
}

/**
 * In-memory reference store, and the baseline the conformance suite runs
 * against. Per-thread entries are held in a contiguous, index-ordered list;
 * append's check-and-push runs synchronously (no `await` between reading the
 * length and writing), so two appends racing on the same `expectedIndex`
 * resolve to exactly one winner. Every stored and returned entry is
 * `structuredClone`d, so a caller can neither mutate stored state through a
 * value it appended nor through a value it read.
 */
export function createInMemoryEventLogStore(): AgentEventLogStore {
  // threadId → entries, index i holding the entry whose `index` is i (contiguous).
  const threads = new Map<string, AgentLogEntry[]>();
  const clone = <T>(value: T): T => structuredClone(value);

  return {
    async append({ threadId, expectedIndex, entries }) {
      // Contiguity: every entry.index must follow expectedIndex in order.
      for (let i = 0; i < entries.length; i++) {
        if (entries[i]!.index !== expectedIndex + i) {
          throw new Error(
            `AgentEventLogStore.append: entry.index (${entries[i]!.index}) must be contiguous ` +
              `from expectedIndex (${expectedIndex}); expected ${expectedIndex + i} at position ${i} ` +
              `on thread "${threadId}".`,
          );
        }
      }
      const list = threads.get(threadId);
      const length = list ? list.length : 0;
      if (length !== expectedIndex) {
        throw new AgentEventLogConflictError(threadId, expectedIndex, length);
      }
      const cloned = entries.map((entry) => clone(entry));
      if (list) {
        for (const entry of cloned) list.push(entry);
      } else {
        threads.set(threadId, cloned);
      }
    },

    async read(threadId, options) {
      const list = threads.get(threadId) ?? [];
      const from = options?.from ?? 0;
      return list.slice(from).map((entry) => clone(entry));
    },

    async length(threadId) {
      return threads.get(threadId)?.length ?? 0;
    },

    async fork({ threadId, newThreadId, upToIndex }) {
      if ((threads.get(newThreadId)?.length ?? 0) > 0) {
        throw new Error(
          `AgentEventLogStore.fork: newThreadId "${newThreadId}" already has entries.`,
        );
      }
      const source = threads.get(threadId);
      if (!source) {
        throw new Error(`AgentEventLogStore.fork: unknown source thread "${threadId}".`);
      }
      const upTo = upToIndex ?? source.length;
      if (upTo < 0 || upTo > source.length) {
        throw new Error(
          `AgentEventLogStore.fork: thread "${threadId}" (length ${source.length}) ` +
            `has no index ${upTo} to fork up to.`,
        );
      }
      threads.set(
        newThreadId,
        source.slice(0, upTo).map((entry) => clone(entry)),
      );
    },
  };
}

// ─── Conformance suite ───
//
// Runner-agnostic: a plain async function that throws a descriptive Error on
// the first violation, so any test runner (or a plain script) can drive it
// against its own store. One tier — fork/read/length are cheap enough to be
// core, so this protocol has no optional capabilities.

/** Produces a fresh, empty store for one assertion. */
type CreateStore = () => Promise<AgentEventLogStore> | AgentEventLogStore;

function fail(message: string): never {
  throw new Error(`event-log-store conformance: ${message}`);
}

function entry(index: number, type: string, metadata?: Record<string, unknown>): AgentLogEntry {
  return {
    index,
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
 * append race (exactly one winner); `read({ from })` incremental correctness;
 * thread isolation; metadata round-trip; deep-copy isolation on append and
 * read; and the full fork contract.
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
    if (caught.threadId !== "t" || caught.expectedIndex !== 0 || caught.actualLength !== 1) {
      fail("conflict error must carry threadId, expectedIndex, and the actual length");
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
  }
}
