/**
 * Durable storage for {@link AgentLogEntry} logs: the one interface a host
 * implements, plus the in-memory reference implementation the conformance
 * suite is written against.
 * @module
 */
import { AgentError } from "./errors.js";
import { assertAgentLogEntry, type AgentLogEntry } from "./event-log.js";

/**
 * An append-only event log: the authoritative durability artifact of a thread.
 * The journal of external inputs IS the source of truth — deterministic
 * `replay` derives every snapshot from it, and a fork is a copied log prefix.
 *
 * Userland stores (a Postgres table with a `(thread_id, index)` primary key, an
 * append-only object in blob storage, …) implement this one shape so they
 * interoperate; {@link createInMemoryEventLogStore} is the reference, and
 * `assertEventLogStoreConformance` checks an implementation against it.
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
   * Copy the prefix `[0, upToIndex)` onto a fresh, empty `newThreadId`.
   * Without `upToIndex` the full source is copied. The fork then appends
   * independently. Rejects (plain `Error`) if `newThreadId` already has
   * entries, the source is unknown, or `upToIndex` is out of range.
   * Implementations may copy-on-write or physically copy; observable behavior
   * must match a full copy.
   */
  fork(input: {
    threadId: string;
    newThreadId: string;
    /** Exclusive index cutoff. */
    upToIndex?: number;
  }): Promise<void>;
}

/**
 * Rejection from {@link AgentEventLogStore.append} when the thread's stored
 * length is not the `expectedIndex` the writer held — a concurrent writer
 * appended first. `actualIndex` is the next index the store would accept.
 */
export class AgentEventLogConflictError extends AgentError {
  readonly threadId: string;
  readonly expectedIndex: number;
  readonly actualIndex: number;

  constructor(threadId: string, expectedIndex: number, actualIndex: number) {
    super(
      "event-log-conflict",
      `AgentEventLogStore.append: index conflict on thread "${threadId}": ` +
        `expected index ${expectedIndex} but found ${actualIndex} — a concurrent writer won.`,
    );
    this.name = "AgentEventLogConflictError";
    this.threadId = threadId;
    this.expectedIndex = expectedIndex;
    this.actualIndex = actualIndex;
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
      for (const entry of entries) {
        assertAgentLogEntry(entry);
      }
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
      const ids = new Set((list ?? []).map((entry) => entry.id));
      for (const entry of entries) {
        if (ids.has(entry.id)) {
          throw new Error(
            `AgentEventLogStore.append: duplicate event id "${entry.id}" in thread "${threadId}".`,
          );
        }
        ids.add(entry.id);
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
