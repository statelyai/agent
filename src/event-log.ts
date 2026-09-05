/**
 * The event log: an append-only journal of the EXTERNAL inputs a machine
 * consumed, and the pure fold ({@link replay}) that turns that journal back
 * into a snapshot without executing anything.
 *
 * A journaled entry is always an external input — an invoke completion
 * (`xstate.done.actor`/`xstate.error.actor` carrying its output inline), a
 * user-sent event, a timer firing, a reserved `@agent.usage` record. Never a
 * raised/internal event: replay re-derives those from the machine's own logic,
 * so journaling them would double-apply them.
 *
 * A log is self-contained: its reserved first entry ({@link initEntry}) carries
 * either the machine `input` (a fresh start) or a persisted snapshot (a
 * continuation across a machine version, or from a log-less legacy snapshot),
 * so {@link replay} needs no side channel.
 * @module
 */
import {
  initialTransition,
  transition,
  type AnyMachineSnapshot,
  type AnyStateMachine,
  type EventObject,
  type Snapshot,
  type SnapshotFrom,
} from "xstate";
import { AgentError } from "./errors.js";
import { AGENT_USAGE_EVENT_TYPE } from "./usage.js";
import { AGENT_USAGE_TOKEN_FIELDS, type AgentCallUsage } from "./text-logic.js";
import { djb2Hex, resolveMachineVersion } from "./utils.js";

/** The durable entry envelope version. */
export const AGENT_EVENT_SCHEMA_VERSION = 1 as const;

/**
 * The reserved event type of the first entry of every log. It carries the
 * machine `input` (fresh start) or a persisted `snapshot` (continuation), so a
 * log replays with no side channel. Lives in the reserved `@agent.*` namespace
 * so it can never collide with a machine's own vocabulary; it is consumed by
 * {@link replay} and never fed to `transition`.
 */
export const AGENT_INIT_EVENT_TYPE = "@agent.init" as const;

/** Values that round-trip through JSON without adapters or silent coercion. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/** A persisted (JSON-safe) machine snapshot, as `machine.getPersistedSnapshot()` returns. */
export type AgentPersistedSnapshot = Snapshot<unknown>;

/** Recorded projection hash used by {@link replay} verification. */
export interface AgentLogVerification {
  /** {@link getSnapshotStateHash} of the persisted snapshot after this entry is applied. */
  stateHash: string;
}

/**
 * One journaled external input, JSON-safe and stored verbatim.
 */
export interface AgentLogEntry {
  /** Version of this outer envelope, independent of the machine event type. */
  schemaVersion: typeof AGENT_EVENT_SCHEMA_VERSION;
  /** Stable identity within the log. Forked prefixes retain their ids. */
  id: string;
  /** 0-based position in the log. */
  index: number;
  /** RFC 3339 wall-clock time when the host accepted the entry. Metadata only. */
  recordedAt: string;
  /** The authored XState machine id. */
  machineId: string;
  /** Explicit version or structural hash of the machine that accepted the event. */
  machineVersion: string;
  event: EventObject;
  /** Optional causal parent entry id, scoped to the same log. */
  causationId?: string;
  /** Host-owned, JSON-safe; stored verbatim, never interpreted. */
  metadata?: Record<string, JsonValue>;
  /** Recorded projection hash used by replay verification. */
  verification?: AgentLogVerification;
}

/** The payload of the reserved {@link AGENT_INIT_EVENT_TYPE} first entry. */
export interface AgentInitEvent extends EventObject {
  type: typeof AGENT_INIT_EVENT_TYPE;
  /** Machine input for a fresh start. Mutually exclusive with `snapshot`. */
  input?: unknown;
  /** Persisted snapshot to continue from. Mutually exclusive with `input`. */
  snapshot?: AgentPersistedSnapshot;
}

/** A malformed or internally inconsistent log. */
export class AgentEventLogError extends AgentError {
  constructor(message: string) {
    super("invalid-event-log", message);
    this.name = "AgentEventLogError";
  }
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

/** Replay reached a state that does not match the entry's recorded hash. */
export class AgentReplayDivergenceError extends AgentError {
  constructor(
    readonly eventId: string,
    readonly index: number,
    readonly kind: "state" | "missing-verification",
    readonly expected?: string,
    readonly actual?: string,
  ) {
    super(
      "replay-diverged",
      kind === "missing-verification"
        ? `Replay entry '${eventId}' at index ${index} has no recorded verification hash.`
        : `Replay diverged after '${eventId}' at index ${index}: ` +
            `expected state hash '${expected}', got '${actual}'.`,
    );
    this.name = "AgentReplayDivergenceError";
  }
}

/**
 * An entry was recorded against a different machine (id) or a different
 * machine version than the one replaying it. An init-with-snapshot entry is
 * exempt: that entry IS the bridge from the old version to the new one.
 */
export class AgentMachineVersionMismatchError extends AgentError {
  constructor(
    readonly eventId: string,
    readonly index: number,
    readonly expected: { machineId: string; machineVersion: string },
    readonly actual: { machineId: string; machineVersion: string },
  ) {
    super(
      "machine-version-mismatch",
      `Event log entry '${eventId}' at index ${index} targets machine ` +
        `'${actual.machineId}'@'${actual.machineVersion}', expected ` +
        `'${expected.machineId}'@'${expected.machineVersion}'.`,
    );
    this.name = "AgentMachineVersionMismatchError";
  }
}

// --- JSON safety -----------------------------------------------------------

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
    throw new AgentEventLogError(`Agent event ${label} must be a non-empty string${qualifier}.`);
  }
}

/** Validates the complete durable envelope before append/export/replay. */
export function assertAgentLogEntry(entry: unknown): asserts entry is AgentLogEntry {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    throw new AgentEventLogError("Agent event entry must be an object.");
  }
  assertJsonSerializable(entry);
  const candidate = entry as Partial<AgentLogEntry>;
  if (candidate.schemaVersion !== AGENT_EVENT_SCHEMA_VERSION) {
    throw new AgentEventLogError(
      `Unsupported agent event schema version '${String(candidate.schemaVersion)}'; ` +
        `expected '${AGENT_EVENT_SCHEMA_VERSION}'.`,
    );
  }
  if (!Number.isInteger(candidate.index) || candidate.index! < 0) {
    throw new AgentEventLogError(
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
    throw new AgentEventLogError(
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
    throw new AgentEventLogError("Agent event entry.event requires a non-empty string type.");
  }
  if (candidate.causationId !== undefined) {
    requireNonEmptyString(candidate.causationId, "entry.causationId", " when present");
  }
  if (
    candidate.metadata !== undefined &&
    (candidate.metadata === null ||
      typeof candidate.metadata !== "object" ||
      Array.isArray(candidate.metadata))
  ) {
    throw new AgentEventLogError("Agent event entry.metadata must be an object when present.");
  }
  if (
    candidate.verification !== undefined &&
    (candidate.verification === null ||
      typeof candidate.verification !== "object" ||
      typeof candidate.verification.stateHash !== "string" ||
      !candidate.verification.stateHash)
  ) {
    throw new AgentEventLogError(
      "Agent event entry.verification requires a non-empty stateHash string.",
    );
  }
}

/**
 * Replaces `Error` instances with plain `{ name, message, cause? }` objects so
 * an `xstate.error.actor` payload survives the log's JSON round-trip. Cycles
 * are preserved by identity; non-plain objects are left alone (and are then
 * rejected by {@link assertJsonSerializable}).
 */
function normalizeEventErrors(
  value: unknown,
  seen: WeakMap<object, unknown> = new WeakMap(),
): unknown {
  if (value instanceof Error) {
    const normalized: Record<string, unknown> = {
      name: value.name,
      message: value.message,
    };
    seen.set(value, normalized);
    if (value.cause !== undefined) normalized.cause = normalizeEventErrors(value.cause, seen);
    return normalized;
  }
  if (value === null || typeof value !== "object") return value;
  const existing = seen.get(value);
  if (existing !== undefined) return existing;
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    seen.set(value, result);
    for (const item of value) result.push(normalizeEventErrors(item, seen));
    return result;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  const result: Record<string, unknown> = {};
  seen.set(value, result);
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    result[key] = normalizeEventErrors(item, seen);
  }
  return result;
}

// --- Hashing ---------------------------------------------------------------

// Keys stripped from a persisted snapshot before hashing: they are re-minted on
// every fold (actor session ids, the actor/timer id counters) and so differ
// between two runs that are otherwise identical.
const VOLATILE_SNAPSHOT_KEYS = new Set(["sessionId", "_nextTimerId", "_nextActorIds"]);

function canonicalizeForHash(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === undefined) return "[undefined]";
  if (typeof value === "function") return "[function]";
  if (typeof value === "bigint") return `[bigint:${String(value)}]`;
  if (typeof value === "symbol") return `[symbol:${String(value)}]`;
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return `[Date:${value.toISOString()}]`;
  if (value instanceof Error) {
    return {
      errorName: value.name,
      message: value.message,
      ...(value.cause !== undefined ? { cause: canonicalizeForHash(value.cause, seen) } : {}),
    };
  }
  if (value instanceof Set) {
    return [...value]
      .map((item) => canonicalizeForHash(item, seen))
      .sort((a, b) => stableJson(a).localeCompare(stableJson(b)));
  }
  if (value instanceof Map) {
    return [...value.entries()]
      .map(([key, item]) => [canonicalizeForHash(key, seen), canonicalizeForHash(item, seen)])
      .sort(([a], [b]) => stableJson(a).localeCompare(stableJson(b)));
  }
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) {
    const result = value.map((item) => canonicalizeForHash(item, seen));
    seen.delete(value);
    return result;
  }
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    if (VOLATILE_SNAPSHOT_KEYS.has(key)) continue;
    const child = (value as Record<string, unknown>)[key];
    // Undefined values are dropped rather than encoded: a persisted snapshot
    // carries `output`/`error` as explicit `undefined` before it is serialized,
    // and a JSON round-trip drops them, so both forms must hash alike.
    if (child === undefined) continue;
    result[key] = canonicalizeForHash(child, seen);
  }
  seen.delete(value);
  return result;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, sortJson((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

/**
 * The canonical hash of a PERSISTED snapshot (`machine.getPersistedSnapshot()`,
 * or {@link replay}'s `persistedSnapshot`) — the value recorded in an entry's
 * `verification.stateHash`.
 *
 * Stripped before hashing, because they are re-minted on every fold and would
 * otherwise make two identical runs hash differently: any `sessionId` (child
 * actor session identity), `_nextTimerId` and `_nextActorIds` (id counters),
 * and `undefined`-valued properties (so a snapshot hashes the same before and
 * after a JSON round-trip). Object keys are sorted, so key order is irrelevant.
 *
 * A change detector, not a cryptographic digest.
 */
export function getSnapshotStateHash(snapshot: AgentPersistedSnapshot | unknown): string {
  return djb2Hex(stableJson(canonicalizeForHash(snapshot)));
}

// --- Entries ---------------------------------------------------------------

/** Options controlling the durable envelope created by {@link createReplayEntry}. */
export interface CreateReplayEntryOptions {
  /** Explicit machine version; defaults to the machine's resolved version. */
  machineVersion?: string;
  /** Stable entry id; defaults to `evt_` plus the zero-padded index. */
  id?: string;
  /** RFC 3339 acceptance time; defaults to the current wall clock. */
  recordedAt?: string;
  causationId?: string;
  metadata?: Record<string, JsonValue>;
  /** Record `verification.stateHash` (default `true`). */
  verification?: boolean;
  /**
   * The snapshot this entry folds to, when the caller already has it — avoids
   * re-folding the whole prefix just to compute the hash. Accepts a live or a
   * persisted snapshot.
   */
  snapshot?: AnyMachineSnapshot | AgentPersistedSnapshot;
}

function machineIdOf(machine: AnyStateMachine): string {
  return (machine.config as { id?: string }).id ?? machine.id ?? "(machine)";
}

function toPersisted(
  machine: AnyStateMachine,
  snapshot: AnyMachineSnapshot | AgentPersistedSnapshot,
): AgentPersistedSnapshot {
  // A live MachineSnapshot carries `machine`/`children` actor refs; the
  // persisted projection is the hashable one.
  return typeof (snapshot as AnyMachineSnapshot).matches === "function"
    ? (machine.getPersistedSnapshot(snapshot as AnyMachineSnapshot) as AgentPersistedSnapshot)
    : (snapshot as AgentPersistedSnapshot);
}

/**
 * Creates a JSON-safe, self-describing entry for `event` appended after
 * `entries` (which must be the complete prefix, so `index` and the recorded
 * state hash line up).
 */
export function createReplayEntry(
  machine: AnyStateMachine,
  entries: readonly AgentLogEntry[],
  event: EventObject,
  options: CreateReplayEntryOptions = {},
): AgentLogEntry {
  const index = entries.length;
  const machineVersion = options.machineVersion ?? resolveMachineVersion(machine);
  const entry: AgentLogEntry = {
    schemaVersion: AGENT_EVENT_SCHEMA_VERSION,
    id: options.id ?? `evt_${String(index).padStart(8, "0")}`,
    index,
    recordedAt: options.recordedAt ?? new Date().toISOString(),
    machineId: machineIdOf(machine),
    machineVersion,
    event: normalizeEventErrors(event) as EventObject,
    ...(options.causationId !== undefined ? { causationId: options.causationId } : {}),
    ...(options.metadata !== undefined ? { metadata: options.metadata } : {}),
  };
  assertAgentLogEntry(entry);
  if (options.verification !== false) {
    const persisted = options.snapshot
      ? toPersisted(machine, options.snapshot)
      : replay(machine, [...entries, entry], { machineVersion, verify: false }).persistedSnapshot;
    // The only field attached after validation; the hash is always non-empty
    // hex, so the envelope stays valid.
    entry.verification = { stateHash: getSnapshotStateHash(persisted) };
  }
  return entry;
}

/** How a log begins: from machine input, or from a persisted snapshot. */
export type AgentLogInit =
  | { input?: unknown; snapshot?: never }
  | {
      snapshot: AgentPersistedSnapshot;
      input?: never;
    };

// A persisted snapshot carries `output`/`error` as explicit `undefined` before
// serialization; JSON drops those keys, and so does this, so the entry passes
// `assertJsonSerializable` and hashes identically before and after a round-trip.
function pruneUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(pruneUndefined);
  if (value === null || typeof value !== "object") return value;
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    return value;
  }
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (child === undefined) continue;
    result[key] = pruneUndefined(child);
  }
  return result;
}

/**
 * The reserved first entry of a log. Pass EXACTLY one of:
 *
 * - `{ input }` — a fresh start; replay folds from `initialTransition`.
 * - `{ snapshot }` — a continuation from a persisted snapshot: a version
 *   bridge, or a legacy snapshot that predates the log. Replay restores it
 *   purely (no actors started) and folds the rest of the log onto it.
 *
 * `options.metadata.executionId` names the lineage; this library always sets
 * one, and readers must tolerate its absence in logs written elsewhere.
 */
export function initEntry(
  machine: AnyStateMachine,
  init: AgentLogInit = {},
  options: CreateReplayEntryOptions = {},
): AgentLogEntry {
  const hasSnapshot = init.snapshot !== undefined;
  if (hasSnapshot && init.input !== undefined) {
    throw new AgentEventLogError(
      "initEntry accepts exactly one of `input` (fresh start) or `snapshot` (continuation).",
    );
  }
  const event: AgentInitEvent = {
    type: AGENT_INIT_EVENT_TYPE,
    ...(hasSnapshot
      ? { snapshot: pruneUndefined(init.snapshot) as AgentPersistedSnapshot }
      : init.input !== undefined
        ? { input: init.input }
        : {}),
  };
  return createReplayEntry(machine, [], event, options);
}

/** Whether `entry` is the reserved init entry. */
function isInitEntry(entry: AgentLogEntry): boolean {
  return entry.event.type === AGENT_INIT_EVENT_TYPE;
}

/** Whether `entry` is the version-bridging init-with-snapshot entry. */
function isSnapshotInitEntry(entry: AgentLogEntry): boolean {
  return isInitEntry(entry) && (entry.event as AgentInitEvent).snapshot !== undefined;
}

/**
 * The log's execution id: the lineage identity pinned in the init entry's
 * `metadata.executionId`.
 *
 * Minted once per run and inherited verbatim by every resume of that log, so
 * it names one lineage rather than one process. Entry ids cannot serve this
 * role — the built-in ids are index-derived, so every log's init entry is
 * `evt_00000000`. A fork copies the init entry, so it shares its parent's
 * execution id by construction.
 *
 * Returns `undefined` for a log with no init entry and for one written without
 * the field — callers must treat the id as optional.
 */
export function getLogExecutionId(entries: readonly AgentLogEntry[]): string | undefined {
  const init = entries.find((entry) => isInitEntry(entry));
  const executionId = (init?.metadata as { executionId?: unknown } | undefined)?.executionId;
  return typeof executionId === "string" ? executionId : undefined;
}

/**
 * Validates a log before replay or append: every envelope well-formed, indices
 * contiguous from 0, ids unique, the first entry the reserved init entry, and
 * one consistent machine identity throughout.
 *
 * With `machine`, entries are also checked against that machine's id and
 * resolved version — a mismatch throws {@link AgentMachineVersionMismatchError}.
 * An init-with-snapshot entry is exempt from the version check: that entry is
 * itself the bridge from whatever version produced the snapshot.
 */
export function validateReplayEntries(
  entries: readonly AgentLogEntry[],
  options: { machine?: AnyStateMachine; machineVersion?: string } = {},
): void {
  if (entries.length === 0) {
    return;
  }
  const expected = options.machine
    ? {
        machineId: machineIdOf(options.machine),
        machineVersion: options.machineVersion ?? resolveMachineVersion(options.machine),
      }
    : {
        machineId: entries[0]!.machineId,
        machineVersion: options.machineVersion ?? entries[0]!.machineVersion,
      };
  const ids = new Set<string>();
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    assertAgentLogEntry(entry);
    if (entry.index !== index) {
      throw new AgentEventLogError(
        `Event log must be contiguous from index 0; found entry.index ${entry.index} ` +
          `at position ${index}.`,
      );
    }
    if (ids.has(entry.id)) {
      throw new AgentEventLogError(`Event log contains duplicate entry id '${entry.id}'.`);
    }
    ids.add(entry.id);
    if (index === 0 && !isInitEntry(entry)) {
      throw new AgentEventLogError(
        `Event log must start with the reserved '${AGENT_INIT_EVENT_TYPE}' entry; ` +
          `found '${entry.event.type}'.`,
      );
    }
    if (index > 0 && isInitEntry(entry)) {
      throw new AgentEventLogError(
        `Event log has a second '${AGENT_INIT_EVENT_TYPE}' entry at index ${index}.`,
      );
    }
    const versionMatches = entry.machineVersion === expected.machineVersion;
    if (
      entry.machineId !== expected.machineId ||
      (!versionMatches && !isSnapshotInitEntry(entry))
    ) {
      throw new AgentMachineVersionMismatchError(entry.id, entry.index, expected, {
        machineId: entry.machineId,
        machineVersion: entry.machineVersion,
      });
    }
  }
}

/**
 * The prefix `[0, upToIndex)` of a log, as a new log. `upToIndex` is exclusive
 * and must leave the init entry in place, so the fork is still self-contained.
 */
export function forkEventLog(
  entries: readonly AgentLogEntry[],
  upToIndex: number,
): AgentLogEntry[] {
  if (!Number.isInteger(upToIndex) || upToIndex < 1 || upToIndex > entries.length) {
    throw new AgentEventLogError(
      `forkEventLog: upToIndex must be an integer in [1, ${entries.length}]; got ${String(upToIndex)}.`,
    );
  }
  const forked = entries.slice(0, upToIndex);
  if (!isInitEntry(forked[0]!)) {
    throw new AgentEventLogError(
      `forkEventLog: the forked prefix must start with the reserved '${AGENT_INIT_EVENT_TYPE}' entry.`,
    );
  }
  return forked;
}

// --- Occurrence + usage ----------------------------------------------------

const DONE_ACTOR_EVENT_TYPE = "xstate.done.actor";
const ERROR_ACTOR_EVENT_TYPE = "xstate.error.actor";

/** Normalizes a mixed `EventObject | AgentLogEntry` history into bare events. */
function toEvents(history: readonly (EventObject | AgentLogEntry)[] | undefined): EventObject[] {
  if (!history) {
    return [];
  }
  return history.map((entry) => {
    const candidate = entry as AgentLogEntry;
    return candidate && typeof candidate === "object" && "event" in candidate && candidate.event
      ? candidate.event
      : (entry as EventObject);
  });
}

/**
 * The 1-based occurrence `n` for the NEXT call at invoke site `siteId`:
 * `1 + completions`, where a completion is a journaled `xstate.done.actor` OR
 * `xstate.error.actor` for that `actorId` (an error is a semantic completion).
 * The one counting rule behind every `${siteId}#${n}` call key, so a live run
 * and a replay derive the same `n` by construction.
 */
export function agentCallOccurrence(
  history: readonly (EventObject | AgentLogEntry)[] | undefined,
  siteId: string,
): number {
  let count = 0;
  for (const event of toEvents(history)) {
    if (
      (event.type === DONE_ACTOR_EVENT_TYPE || event.type === ERROR_ACTOR_EVENT_TYPE) &&
      (event as EventObject & { actorId?: unknown }).actorId === siteId
    ) {
      count++;
    }
  }
  return count + 1;
}

/**
 * Folds the reserved `@agent.usage` entries of a log into one cumulative usage
 * total. The log is the source of truth, so the totals are a pure projection of
 * it: replay a log, fold it, and you get the numbers the run reported with no
 * host-side accumulator in between.
 *
 * Accepts entries or bare events. Token fields are partial sums: a field stays
 * `undefined` until some entry reports it, and non-finite values are ignored.
 */
export function getUsageFromEvents(
  entries: readonly (EventObject | AgentLogEntry)[],
): AgentCallUsage {
  const totals: AgentCallUsage = {};
  for (const event of toEvents(entries)) {
    if (event.type !== AGENT_USAGE_EVENT_TYPE) {
      continue;
    }
    const usage = (event as { usage?: unknown }).usage;
    if (!usage || typeof usage !== "object") {
      continue;
    }
    for (const field of AGENT_USAGE_TOKEN_FIELDS) {
      const value = (usage as Record<string, unknown>)[field];
      if (typeof value === "number" && Number.isFinite(value)) {
        totals[field] = (totals[field] ?? 0) + value;
      }
    }
  }
  return totals;
}

// --- Replay ----------------------------------------------------------------

/**
 * Rewrites a journaled `xstate.done.actor`/`xstate.error.actor` event's
 * `sessionId` to the session the CURRENT fold minted for that `actorId`.
 *
 * Session ids are re-minted on every fold, and XState drops a completion event
 * whose `sessionId` does not match the live child — silently, as a no-op
 * transition. Rebinding is what makes a journaled completion replayable at all.
 * `sessions` caches the mapping per fold, so a later event referring to the
 * recorded session of an already-stopped child still resolves.
 */
export function rebindActorSession(
  event: EventObject,
  snapshot: AnyMachineSnapshot,
  sessions: Map<string, string>,
): EventObject {
  const actorEvent = event as EventObject & { actorId?: unknown; sessionId?: unknown };
  if (typeof actorEvent.actorId !== "string" || typeof actorEvent.sessionId !== "string") {
    return event;
  }

  const key = `${actorEvent.actorId}\0${actorEvent.sessionId}`;
  let sessionId = sessions.get(key);
  if (!sessionId) {
    const child = (snapshot.children as Record<string, { sessionId?: unknown }>)[
      actorEvent.actorId
    ];
    if (typeof child?.sessionId !== "string") {
      return event;
    }
    sessionId = child.sessionId;
    sessions.set(key, sessionId);
  }

  return { ...event, sessionId } as EventObject;
}

/** Options for {@link replay}. */
export interface ReplayOptions {
  /** Explicit expected machine version; defaults to the machine's resolved version. */
  machineVersion?: string;
  /**
   * `true` (default) checks the entries that carry a `verification.stateHash`;
   * `'strict'` additionally requires every entry to carry one; `false` skips
   * verification entirely.
   */
  verify?: boolean | "strict";
}

/** The result of a {@link replay}. */
export interface ReplayResult<TMachine extends AnyStateMachine> {
  /** The folded live snapshot (no actors started, no effects run). */
  snapshot: SnapshotFrom<TMachine>;
  /** Its persisted projection — what a host stores, and what hashes. */
  persistedSnapshot: AgentPersistedSnapshot;
}

function verifyEntry(
  entry: AgentLogEntry,
  persisted: AgentPersistedSnapshot,
  mode: ReplayOptions["verify"],
): void {
  if (mode === false) {
    return;
  }
  if (!entry.verification) {
    if (mode === "strict") {
      throw new AgentReplayDivergenceError(entry.id, entry.index, "missing-verification");
    }
    return;
  }
  const actual = getSnapshotStateHash(persisted);
  if (actual !== entry.verification.stateHash) {
    throw new AgentReplayDivergenceError(
      entry.id,
      entry.index,
      "state",
      entry.verification.stateHash,
      actual,
    );
  }
}

/**
 * Folds a log through XState's pure `initialTransition`/`transition` WITHOUT
 * executing anything: no actor is started, no action runs, no model is called.
 * A journaled `xstate.done.actor` entry carries the completed actor's output
 * inline, so the invoke it belongs to is never re-run. Crash recovery, fork
 * resume, and time travel in one call.
 *
 * The first entry is the reserved {@link initEntry}: `input` folds from
 * `initialTransition`, `snapshot` restores the persisted snapshot purely
 * (`machine.restoreSnapshot`) and folds the rest of the log onto it.
 */
export function replay<TMachine extends AnyStateMachine>(
  machine: TMachine,
  entries: readonly AgentLogEntry[],
  options: ReplayOptions = {},
): ReplayResult<TMachine> {
  const machineVersion = options.machineVersion ?? resolveMachineVersion(machine);
  validateReplayEntries(entries, { machine, machineVersion });
  if (entries.length === 0) {
    throw new AgentEventLogError(
      `Cannot replay an empty event log; it must start with a '${AGENT_INIT_EVENT_TYPE}' entry.`,
    );
  }
  const initEvent = entries[0]!.event as AgentInitEvent;
  let snapshot = (
    initEvent.snapshot !== undefined
      ? (
          machine as unknown as {
            restoreSnapshot(persisted: AgentPersistedSnapshot): AnyMachineSnapshot;
          }
        ).restoreSnapshot(initEvent.snapshot)
      : initialTransition(machine, initEvent.input as never)[0]
  ) as AnyMachineSnapshot;
  let persisted = machine.getPersistedSnapshot(snapshot) as AgentPersistedSnapshot;
  verifyEntry(entries[0]!, persisted, options.verify);

  const sessions = new Map<string, string>();
  for (let index = 1; index < entries.length; index++) {
    const entry = entries[index]!;
    const event = rebindActorSession(entry.event, snapshot, sessions);
    [snapshot] = transition(machine, snapshot as never, event as never) as [
      AnyMachineSnapshot,
      unknown,
    ];
    persisted = machine.getPersistedSnapshot(snapshot) as AgentPersistedSnapshot;
    verifyEntry(entry, persisted, options.verify);
  }

  return { snapshot: snapshot as SnapshotFrom<TMachine>, persistedSnapshot: persisted };
}
