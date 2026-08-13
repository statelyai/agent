import type { EventObject } from "xstate";
import { AgentError } from "./errors.js";

/** The durable replay-entry envelope version. */
export const AGENT_EVENT_SCHEMA_VERSION = 1 as const;

/** Values that round-trip through JSON without adapters or silent coercion. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface AgentLogVerification {
  /** Hash of the logical machine projection after this entry is applied. */
  stateHash: string;
  /** Hash of the serializable effects owed at that frontier. */
  effectsHash: string;
}

/**
 * One journaled entry: an EXTERNAL input to the machine — an effect completion
 * (a `done`/`error` event carrying its output inline), a user-sent event, or a
 * timer firing. Never a raised/internal event: deterministic replay re-derives
 * those from the machine's own logic, so journaling them would double-apply.
 * JSON-safe, stored verbatim.
 */
export interface AgentLogEntry {
  /** Version of this outer envelope, independent of the machine event type. */
  schemaVersion: typeof AGENT_EVENT_SCHEMA_VERSION;
  /** Stable identity within the thread. Forked prefixes retain their ids. */
  id: string;
  /** 0-based position in the thread's log. */
  index: number;
  /** RFC 3339 wall-clock time when the host accepted the entry. Metadata only. */
  recordedAt: string;
  /** The authored XState machine id. */
  machineId: string;
  /** Explicit version or structural hash of the machine that accepted the event. */
  machineVersion: string;
  event: EventObject;
  /** Optional causal parent entry id, scoped to the same thread. */
  causationId?: string;
  /** Optional host-owned correlation id spanning threads/runs. */
  correlationId?: string;
  /** Recorded projection hashes used by strict replay verification. */
  verification?: AgentLogVerification;
  /** Host-owned, JSON-safe; stored verbatim, never interpreted. */
  metadata?: Record<string, JsonValue>;
}

/** A precise failure when an entry would not survive a JSON round-trip. */
export class NonSerializableAgentEventError extends AgentError {
  readonly path: string;
  readonly valueType: string;

  constructor(path: string, valueType: string) {
    super(
      "non-serializable-event",
      `Agent event field '${path}' is not JSON-serializable (${valueType}).`,
    );
    this.name = "NonSerializableAgentEventError";
    this.path = path;
    this.valueType = valueType;
  }
}

// Symbol keys and non-enumerable string properties are silently dropped by
// JSON, so both the array and object branches below reject them. `isOwnKey`
// exempts the string keys a container legitimately owns (an array's `length`
// and its indices).
function assertNoHiddenKeys(
  value: object,
  path: string,
  isOwnKey?: (key: string) => boolean,
): void {
  const symbols = Object.getOwnPropertySymbols(value);
  if (symbols.length > 0) {
    throw new NonSerializableAgentEventError(`${path}.[${String(symbols[0])}]`, "symbol key");
  }
  const hiddenKey = Object.getOwnPropertyNames(value).find(
    (key) => !isOwnKey?.(key) && !Object.getOwnPropertyDescriptor(value, key)?.enumerable,
  );
  if (hiddenKey !== undefined) {
    throw new NonSerializableAgentEventError(`${path}.${hiddenKey}`, "non-enumerable property");
  }
}

// Canonical array index, as JSON.stringify treats them.
const arrayIndexPattern = /^(?:0|[1-9]\d*)$/;

/**
 * Rejects values JSON would drop or coerce. Unlike `JSON.stringify`, this does
 * not silently erase `undefined`/functions or turn non-finite numbers into
 * `null`; durable entries contain only plain JSON values.
 */
export function assertJsonSerializable(
  value: unknown,
  path = "entry",
  ancestors: WeakSet<object> = new WeakSet(),
): asserts value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new NonSerializableAgentEventError(path, Object.is(value, -0) ? "-0" : String(value));
    }
    return;
  }
  if (typeof value !== "object") {
    throw new NonSerializableAgentEventError(path, typeof value);
  }
  if (ancestors.has(value)) {
    throw new NonSerializableAgentEventError(path, "circular reference");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index++) {
        if (!Object.hasOwn(value, index)) {
          throw new NonSerializableAgentEventError(`${path}[${index}]`, "array hole");
        }
        assertJsonSerializable(value[index], `${path}[${index}]`, ancestors);
      }
      const extraKey = Object.keys(value).find(
        (key) => !arrayIndexPattern.test(key) || Number(key) >= value.length,
      );
      if (extraKey !== undefined) {
        throw new NonSerializableAgentEventError(`${path}.${extraKey}`, "array property");
      }
      assertNoHiddenKeys(value, path, (key) => key === "length" || arrayIndexPattern.test(key));
      return;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      const type = (value as { constructor?: { name?: string } }).constructor?.name ?? "object";
      throw new NonSerializableAgentEventError(path, type);
    }
    assertNoHiddenKeys(value, path);
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      assertJsonSerializable(child, `${path}.${key}`, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

// Every string field of the envelope has the same rule; naming the field in the
// message is what makes a rejected entry diagnosable.
function requireNonEmptyString(value: unknown, label: string, qualifier = ""): void {
  if (typeof value !== "string" || !value) {
    throw new Error(`Agent event ${label} must be a non-empty string${qualifier}.`);
  }
}

/** Validates the complete durable envelope before append/export/replay. */
export function assertAgentLogEntry(entry: unknown): asserts entry is AgentLogEntry {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error("Agent event entry must be an object.");
  }
  assertJsonSerializable(entry);
  const candidate = entry as Partial<AgentLogEntry>;
  if (candidate.schemaVersion !== AGENT_EVENT_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported agent event schema version '${String(candidate.schemaVersion)}'; ` +
        `expected '${AGENT_EVENT_SCHEMA_VERSION}'.`,
    );
  }
  if (!Number.isInteger(candidate.index) || candidate.index! < 0) {
    throw new Error(
      `Agent event entry.index must be a non-negative integer; got ${String(candidate.index)}.`,
    );
  }
  for (const field of ["id", "machineId", "machineVersion"] as const) {
    requireNonEmptyString(candidate[field], `entry.${field}`);
  }
  if (
    typeof candidate.recordedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      candidate.recordedAt,
    ) ||
    Number.isNaN(Date.parse(candidate.recordedAt))
  ) {
    throw new Error(
      `Agent event entry.recordedAt is not RFC 3339: '${String(candidate.recordedAt)}'.`,
    );
  }
  if (
    candidate.event === null ||
    typeof candidate.event !== "object" ||
    Array.isArray(candidate.event) ||
    typeof candidate.event.type !== "string" ||
    !candidate.event.type
  ) {
    throw new Error("Agent event entry.event requires a non-empty string type.");
  }
  for (const field of ["causationId", "correlationId"] as const) {
    if (candidate[field] !== undefined) {
      requireNonEmptyString(candidate[field], `entry.${field}`, " when present");
    }
  }
  if (
    candidate.metadata !== undefined &&
    (candidate.metadata === null ||
      typeof candidate.metadata !== "object" ||
      Array.isArray(candidate.metadata))
  ) {
    throw new Error("Agent event entry.metadata must be an object when present.");
  }
  if (
    candidate.verification !== undefined &&
    (candidate.verification === null ||
      typeof candidate.verification !== "object" ||
      typeof candidate.verification.stateHash !== "string" ||
      !candidate.verification.stateHash ||
      typeof candidate.verification.effectsHash !== "string" ||
      !candidate.verification.effectsHash)
  ) {
    throw new Error(
      "Agent event entry.verification requires non-empty stateHash and effectsHash strings.",
    );
  }
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

// The runner-agnostic store conformance suite lives in its own module;
// re-exported here (and from the package root) so the public surface is
// unchanged.
export { assertEventLogStoreConformance } from "./event-log-store-conformance.js";
