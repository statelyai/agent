import {
  createAsyncLogic,
  getNextTransitions,
  isMachineSnapshot,
  stopActor,
  type AnyActor,
  type AnyActorLogic,
  type AnyActorRef,
  type AnyMachineSnapshot,
  type AnyStateMachine,
  type EmittedFrom,
  type EventFromLogic,
  type EventObject,
  type InputFrom,
  type InspectionEvent,
  type OutputFrom,
  type Snapshot,
  type SnapshotFrom,
} from "xstate";
import { createDurable, type DurableExecution } from "xstate/durable";
import type {
  AgentTools,
  ChosenEvent,
  InferInput,
  StandardSchemaV1,
  WithAgentInputSchema,
} from "./types.js";
import { AgentError } from "./errors.js";
import { AgentEventLogConflictError, type AgentEventLogStore } from "./event-log-store.js";
import {
  findNonSerializableContextPaths,
  isStandardSchema,
  resolveMachineVersion,
  validateSchemaSync,
} from "./utils.js";
import { getAcceptedEvents, type AgentSchemas } from "./events.js";
import {
  GENERATE_TEXT_ACTOR,
  getCallFinishReason,
  getCallUsage,
  isTextLogic,
  normalizeGeneratorResult,
  STREAM_TEXT_ACTOR,
  type AgentCallUsage,
  type AgentFinishReason,
  type AgentUsage,
  type AgentExecutorTextRequest,
  type AgentRequestExecutor,
  type AgentRequestExecutors,
  type AgentTextRequest,
  type TextLogic,
  responseMessagesOf,
} from "./text-logic.js";
import {
  AgentDecisionExhaustedError,
  isDecisionLogic,
  resolveDecision,
  type AgentDecisionExecutor,
  type AgentDecisionRequest,
  type DecisionLogic,
} from "./decision.js";
import type { AgentRequest, AgentStepRequest } from "./steps.js";
import {
  executorBoundLogics,
  getRegisteredAgentExecutionOptions,
  isUnboundPlaceholder,
} from "./internal/registry.js";
import { AGENT_USAGE_EVENT_TYPE, type AgentUsageEvent } from "./usage.js";
import {
  AgentMachineVersionMismatchError,
  agentCallOccurrence,
  createReplayEntry,
  getLogExecutionId,
  getSnapshotStateHash,
  getUsageFromEvents,
  initEntry,
  replay,
  validateReplayEntries,
  type AgentLogEntry,
  type AgentLogInit,
  type AgentPersistedSnapshot,
  type JsonValue as AgentLogJsonValue,
  canonicalEventJson,
} from "./event-log.js";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

// ─── The agent loop ───
//
// `createAgentRuntime` binds host executors onto the machine's agent actor
// sources and runs it on XState's durable transition loop: every transition
// is pure, effects start work, and everything that finishes lands in one
// mailbox. The host writes the loop; `runToQuiescence` is the blocking one.

/**
 * Thrown by {@link AgentRuntime.start} when a resume is given BOTH an `events` log and a
 * `snapshot` that claims a position in that log (`agentMeta.logIndex`), and the
 * two disagree about the state at that position. The log is the source of
 * truth, so this is a host bug (a snapshot cached from a different lineage, or
 * a snapshot mutated out of band), not a recoverable resume: pass the log
 * alone, or the matching snapshot.
 */
export class AgentSnapshotDivergedError extends AgentError {
  constructor(
    readonly expected: string,
    readonly actual: string,
    readonly logIndex: number,
  ) {
    super(
      "snapshot-diverged",
      `createAgentRuntime: the resume snapshot disagrees with the event log at index ${logIndex}: ` +
        `the log replays to state hash '${expected}', the snapshot hashes '${actual}'.`,
    );
    this.name = "AgentSnapshotDivergedError";
  }
}

/**
 * The stamp {@link AgentRunResult.persist} writes onto the persisted snapshot:
 * the machine identity that produced it plus the position in the event log it
 * caches. Read back by the next resume to decide whether the snapshot can be
 * trusted without replaying the log (see {@link AgentRunStart.events}).
 */
export interface AgentRunMeta {
  machineId: string;
  version: string;
  /** The log's `executionId` lineage, when the log carries one. */
  logId?: string;
  /** The log's length at the moment this snapshot was taken. */
  logIndex: number;
}

// The recorded `verification.stateHash` of a log entry is taken from a
// persisted snapshot BEFORE `persist()` stamps `agentMeta` onto it, so the
// stamp must come back off before a cached snapshot is compared against the
// log.
function hashResumeSnapshot(snapshot: unknown): string {
  if (snapshot !== null && typeof snapshot === "object" && "agentMeta" in snapshot) {
    const rest: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(snapshot as Record<string, unknown>)) {
      if (key !== "agentMeta") {
        rest[key] = value;
      }
    }
    return getSnapshotStateHash(rest);
  }
  return getSnapshotStateHash(snapshot);
}

function readAgentMeta(snapshot: unknown): Partial<AgentRunMeta> | undefined {
  const meta = (snapshot as { agentMeta?: unknown } | undefined)?.agentMeta;
  return meta !== null && typeof meta === "object" ? (meta as Partial<AgentRunMeta>) : undefined;
}

/** Typed root-machine transition observer accepted by {@link createAgentRuntime}. */
export type AgentTransitionHandler<TMachine extends AnyStateMachine> = (
  snapshot: SnapshotFrom<TMachine>,
  event: EventFromLogic<TMachine>,
) => void;

/**
 * The version of the {@link AgentTraceEvent} envelope every trace event carries
 * as `schemaVersion`. Bumped only on a breaking change to the envelope or any
 * payload shape, so a consumer can gate on it. Emitted identically by
 * {@link createAgentRuntime}, {@link provideExecutors}' `onTrace`, and
 * {@link traceTransitions}.
 */
export const AGENT_TRACE_SCHEMA_VERSION = 1;

export type AgentTraceEvent<TMachine extends AnyStateMachine = AnyStateMachine> = {
  /** The {@link AGENT_TRACE_SCHEMA_VERSION} the event was produced with. */
  schemaVersion: typeof AGENT_TRACE_SCHEMA_VERSION;
  runId: string;
  seq: number;
  timestamp: string;
  machineId: string;
  /** The machine's own `version`, else its structural hash. */
  machineVersion: string;
} & (
  | {
      type: "run.start";
      input?: InputFrom<TMachine>;
      snapshot?: Snapshot<unknown>;
      event?: EventFromLogic<TMachine>;
    }
  | { type: "request.start"; request: AgentStepRequest }
  | {
      type: "request.end";
      request: AgentStepRequest;
      output: unknown;
      raw: unknown;
      /** The model's reasoning, lifted off the raw executor result when the
       * request opted into the provider output's `reasoning` field.
       * Present only when the executor surfaced a string `reasoning`. */
      reasoning?: string;
      /** This call's token usage, lifted off the raw executor result's `usage`.
       * Present only when the executor reported it. The run-level total is
       * {@link AgentRunResult.usage}. */
      usage?: AgentCallUsage;
      /** Why the call stopped, lifted off the raw executor result's
       * `finishReason` and normalized. Present only when the executor reported
       * one the {@link AgentFinishReason} union names. */
      finishReason?: AgentFinishReason;
    }
  | { type: "request.error"; request: AgentStepRequest; error: unknown }
  | { type: "stream.chunk"; request: AgentRequest; chunk: string }
  | {
      type: "machine.transition";
      snapshot: SnapshotFrom<TMachine>;
      event: EventFromLogic<TMachine>;
    }
  | { type: "emit"; event: EmittedFrom<TMachine> }
  | {
      /** A reserved `@agent.usage` event the run declined to deliver. The
       * tokens still fold into {@link AgentRunResult.usage}; only the machine
       * event is dropped. */
      type: "usage.dropped";
      event: AgentUsageEvent;
      /** `'settled'`: the call settled after the run's cycle had resolved. */
      reason: "settled";
    }
  | (
      | {
          type: "run.end";
          status: "done";
          output: OutputFrom<TMachine>;
          snapshot: SnapshotFrom<TMachine>;
        }
      | {
          type: "run.end";
          status: "idle";
          snapshot: SnapshotFrom<TMachine>;
        }
      | {
          type: "run.end";
          status: "error";
          cause: AgentRunErrorCause;
          error: unknown;
          snapshot: SnapshotFrom<TMachine>;
        }
    )
);

/**
 * Fields a JSON projection keeps VERBATIM: {@link TRACE_ENVELOPE_KEYS} (the
 * envelope, the `type`/`status`/`cause` discriminants, and the payload fields
 * that are already plain strings) plus `usage.dropped`'s `reason`, which is a
 * string literal — sanitizing it is the identity, so it keeps its literal type.
 * Every other payload field narrows to {@link JsonValue}. @internal
 */
type TraceVerbatimKey = (typeof TRACE_ENVELOPE_KEYS)[number] | "reason";

/** One trace variant's JSON projection. Homomorphic, so `?` modifiers survive. @internal */
type JsonProjectedTraceVariant<TEvent> = {
  [K in keyof TEvent]: K extends TraceVerbatimKey ? TEvent[K] : JsonValue;
};

/**
 * `raw` is written only when `includeRaw` was set, so it is optional on the
 * JSON side even though the live trace always carries it. @internal
 */
type WithOptionalRaw<T> = "raw" extends keyof T ? Omit<T, "raw"> & { raw?: JsonValue } : T;

/**
 * The JSON-safe projection of an {@link AgentTraceEvent} produced by
 * {@link serializeTraceEvent}: the envelope fields are unchanged, and every
 * payload field that can hold a live object (snapshots, machine events, request
 * objects, raw SDK results, errors) is narrowed to a {@link JsonValue}. Safe to
 * hand straight to `JSON.stringify` for a JSONL trace file.
 *
 * DERIVED from {@link AgentTraceEvent}, so a new trace variant cannot silently
 * miss the JSON side. `src/serialize-trace-event.test.ts` pins the result to
 * the shape this type had when it was hand-maintained.
 */
export type JsonSerializableTraceEvent = AgentTraceEvent extends infer TEvent
  ? TEvent extends unknown
    ? WithOptionalRaw<JsonProjectedTraceVariant<TEvent>>
    : never
  : never;

// Envelope fields copied verbatim by serializeTraceEvent; every other field is sanitized.
const TRACE_ENVELOPE_KEYS = [
  "schemaVersion",
  "runId",
  "seq",
  "timestamp",
  "machineId",
  "machineVersion",
  "type",
  "status",
  "cause",
  "reasoning",
  "finishReason",
  "chunk",
] as const;

/**
 * Best-effort JSON projection of an arbitrary value. Never throws: functions,
 * symbols, `undefined`, and cyclic back-references are DROPPED (array holes
 * become `null`), non-finite numbers become `null`, `bigint`s become strings,
 * `Error`s become `{ name, message, stack?, code? }`, and anything with a
 * `toJSON()` (e.g. `Date`) is projected through it — the same losses a
 * `JSON.parse(JSON.stringify(...))` round-trip incurs, minus the throws.
 */
function toJsonValue(value: unknown, ancestors: readonly object[]): JsonValue | undefined {
  if (value === null) {
    return null;
  }
  const type = typeof value;
  if (type === "string" || type === "boolean") {
    return value as JsonValue;
  }
  if (type === "number") {
    return Number.isFinite(value as number) ? (value as number) : null;
  }
  if (type === "bigint") {
    return (value as bigint).toString();
  }
  if (type !== "object") {
    // undefined, function, symbol
    return undefined;
  }

  const object = value as object;
  if (ancestors.includes(object)) {
    return undefined;
  }
  const nextAncestors = [...ancestors, object];

  if (object instanceof Error) {
    const serialized: Record<string, JsonValue> = {
      name: object.name,
      message: object.message,
    };
    if (typeof object.stack === "string") {
      serialized.stack = object.stack;
    }
    const code = (object as { code?: unknown }).code;
    if (typeof code === "string") {
      serialized.code = code;
    }
    const cause = toJsonValue((object as { cause?: unknown }).cause, nextAncestors);
    if (cause !== undefined) {
      serialized.cause = cause;
    }
    return serialized;
  }

  const toJSON = (object as { toJSON?: unknown }).toJSON;
  if (typeof toJSON === "function") {
    return toJsonValue((toJSON as () => unknown).call(object), nextAncestors);
  }

  if (Array.isArray(object)) {
    return object.map((item) => toJsonValue(item, nextAncestors) ?? null);
  }

  const out: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(object)) {
    const serializedItem = toJsonValue(item, nextAncestors);
    if (serializedItem !== undefined) {
      out[key] = serializedItem;
    }
  }
  return out;
}

/**
 * Projects an {@link AgentTraceEvent} into a guaranteed JSON-safe envelope —
 * the form the trace stream is actually sold for (one `JSON.stringify` per line
 * in a JSONL file). Live values are sanitized rather than trusted:
 *
 * - Snapshots (`run.start`, `machine.transition`, `run.end`) go through the
 *   same JSON round-trip as `machine.getPersistedSnapshot(...)`, so what lands on disk is
 *   what a resume would see.
 * - `request.end`'s `raw` (a provider SDK object, frequently cyclic) is DROPPED
 *   unless `includeRaw` is set, in which case it is sanitized like everything
 *   else.
 * - Non-serializable values anywhere (functions, symbols, `undefined`, cyclic
 *   back-references) are dropped; `Error`s become `{ name, message, stack?,
 *   code? }` instead of `{}`. Nothing throws.
 *
 * @example
 * ```ts
 * await appendFile('trace.jsonl', JSON.stringify(serializeTraceEvent(event)) + '\n');
 * ```
 */
export function serializeTraceEvent(
  event: AgentTraceEvent,
  options: { includeRaw?: boolean } = {},
): JsonSerializableTraceEvent {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event)) {
    if (key === "raw" && !options.includeRaw) {
      continue;
    }
    if ((TRACE_ENVELOPE_KEYS as readonly string[]).includes(key)) {
      if (value !== undefined) {
        out[key] = value;
      }
      continue;
    }
    const serialized = toJsonValue(value, []);
    if (serialized !== undefined) {
      out[key] = serialized;
    }
  }
  return out as JsonSerializableTraceEvent;
}

type AgentTraceEventPayload<TMachine extends AnyStateMachine = AnyStateMachine> =
  AgentTraceEvent<TMachine> extends infer TEvent
    ? TEvent extends unknown
      ? Omit<
          TEvent,
          "schemaVersion" | "runId" | "seq" | "timestamp" | "machineId" | "machineVersion"
        >
      : never
    : never;

/**
 * Options for {@link createAgentRuntime}: what the runtime binds and observes.
 * The run's `input`/`snapshot`/`events` go to {@link AgentRuntime.start} (or
 * {@link runToQuiescence}) instead.
 *
 * Host executors are passed as a single {@link AgentRequestExecutors}-shaped
 * set under `executors`. Each executor
 * kind is required only if the machine actually reaches a request of that kind
 * — checked at bind time, before any actor runs. The whole `executors` field is
 * optional: a machine whose agent sources all carry their own executor
 * (`.withExecutor(...)`) needs none.
 */
export interface AgentRuntimeOptions<TMachine extends AnyStateMachine> {
  /**
   * The host executor set backing the machine's agent actors — build it with
   * `createAiSdkExecutors({ models })` from '@statelyai/agent/ai-sdk', or supply
   * `{ generateText?, streamText?, decide? }` by hand. Every slot is optional
   * here: each kind is
   * bind-time-checked only when the machine actually reaches a request of that
   * kind, so e.g. a stream-only machine may pass `{ streamText }` alone.
   */
  executors?: Partial<AgentRequestExecutors>;

  /**
   * Durable log storage, write-ahead. With a `store` the run reads the thread's
   * log to resume from (unless `events` is given, which wins) and writes every
   * appended entry back through {@link AgentEventLogStore.append}, in log
   * order. Writes are awaited before every model call, so a paid call is never
   * made against an unpersisted log; pure transitions never wait. A rejected
   * write (an {@link AgentEventLogConflictError} from a concurrent writer, or
   * any other failure) stops the run: `{ status: 'error', cause: 'journal' }`.
   *
   * Requires {@link AgentRuntimeOptions.threadId}.
   */
  store?: AgentEventLogStore;
  /** The {@link AgentRuntimeOptions.store} thread this run reads and appends to. Required whenever `store` is given. */
  threadId?: string;
  /**
   * Called synchronously as each log entry is appended, init entry first. An
   * observer, never awaited: persisting here is at-least-once and the run does
   * not wait for it. Use {@link AgentRuntimeOptions.store} for write-ahead
   * durability.
   */
  onEvent?: (entry: AgentLogEntry) => void;
  /**
   * Record a `verification.stateHash` on every appended entry (default `true`).
   * The hash is taken O(1) from the live actor's persisted snapshot right after
   * that entry's transition, so `replay(machine, events)` can prove it lands on
   * the same state. Set `false` for a smaller, unverifiable log.
   */
  verification?: boolean;
  // actor sources — sugar for machine.provide({ actors }) before the run
  /** Actor source implementations, merged onto the machine before binding — sugar for `machine.provide({ actors })` ahead of the run. */
  actors?: Record<string, AnyActorLogic>;

  // observation — all void; no callback controls the run
  /**
   * Sugar over {@link onTrace}'s `stream.chunk` events: fires for each streamed
   * chunk of a `mode: 'stream'` text request, alongside the {@link AgentRequest}
   * that produced it (parallel states can interleave multiple streams). Purely
   * observational.
   */
  onChunk?: (chunk: string, info: { request: AgentRequest }) => void;
  /**
   * Sugar over {@link onTrace}'s `request.end` events: fires once per resolved
   * text/decision request with its normalized output and the raw executor
   * result (tool calls, usage, …) — the seam for tracing/observability and
   * event-sourced replay logging.
   */
  onResult?: (request: AgentStepRequest, result: { result: unknown; raw: unknown }) => void;
  /** Fires a single ordered stream of run/request/chunk/transition/emit/end events. Intended for eval traces, JSONL logs, and adapter-owned telemetry/exporters. */
  onTrace?: (event: AgentTraceEvent<TMachine>) => void;
  /**
   * Sugar over {@link onTrace}'s `machine.transition` events: fires on every
   * root-machine transition (snapshot + causing event). Pure observation —
   * progress UIs, logging, tracing. Cannot send events.
   */
  onTransition?: AgentTransitionHandler<TMachine>;
  /**
   * Handlers for events the machine emits (`enq.emit(...)`), keyed by emitted
   * event type — `'*'` catches all. Typed from the machine's `emitted`
   * schemas (`setupAgent({ emitted: { ... } })`). Purely observational, like
   * {@link onTransition}: the machine narrates progress on its own vocabulary
   * (not xstate internals) and the host renders it — a progress UI, an SSE
   * stream, a log line.
   */
  on?: {
    [TType in EmittedFrom<TMachine>["type"] | "*"]?: (
      emitted: EmittedFrom<TMachine> & (TType extends "*" ? unknown : { type: TType }),
    ) => void;
  };
  /**
   * Raw xstate inspection passthrough: fires for every inspection event in
   * the whole actor system — root machine, invoked child machines, spawned
   * actors — each carrying its `actorRef` (`event.actorRef.id`/`.src`). This
   * is the system-wide seam {@link onTransition} (root transitions only)
   * cannot give you: filter `event.type === '@xstate.transition'` and read
   * `event.actorRef` to attribute a child machine's states to the child.
   * Purely observational, like the other callbacks. Unlike them it also
   * fires during the final settle (a child's last transition and stop events
   * arrive while the run is tearing down).
   *
   * Accepts a function or an observer (`{ next }`), matching `createActor`'s
   * `inspect` option, so `@statelyai/sdk`'s `inspector.inspect` plugs in
   * directly.
   */
  inspect?:
    | ((inspectionEvent: InspectionEvent) => void)
    | { next?: (inspectionEvent: InspectionEvent) => void };

  // control
  /**
   * Caps the number of model/decision calls this run may make (each retry of a
   * decision counts separately). Default 100. The overrun is thrown into the
   * invoke that would have made the call, as an
   * {@link AgentMaxModelCallsExceededError} with `code: 'max-model-calls'` — so
   * an `onError` can branch on it and route to a degraded state. Unhandled, it
   * settles `{ status: 'error', cause: 'max-model-calls' }`.
   */
  maxModelCalls?: number; // default 100
  /** Aborts the run; settles `{ status: 'error', cause: 'aborted' }` with `signal.reason` as the error. */
  signal?: AbortSignal;
  /** Where root `after` timers live. Default `"in-process"`. See {@link AgentTimerScheduler}. */
  timers?: AgentTimerScheduler;
}

/**
 * The outcome of a run ({@link AgentRuntime.finish} / {@link runToQuiescence})
 * — always exactly one of three variants, never a throw for a waiting or
 * failed machine (programmer errors like a missing executor still throw,
 * synchronously from {@link createAgentRuntime} before any actor runs).
 * `done`: a final state was reached (`output` is the machine's `OutputFrom`).
 * `idle`: the run went quiescent (no child, request or in-process timer in
 * flight) — resume with a new runtime and `{ snapshot, event }`. `error`: a run-level
 * failure, discriminated by `cause` (`'aborted'`, `'max-model-calls'`,
 * `'decision-exhausted'`, `'machine'` for any other machine error state, or
 * `'stopped'` for an external stop — see {@link AgentRunErrorCause}). Every
 * variant carries the final `snapshot` and a native XState persistence
 * function. The
 * underlying actor is stopped on every settle path — there is no live actor to
 * resume; resume is always by snapshot.
 */
type AgentRunOutcome<TMachine extends AnyStateMachine> =
  | { status: "done"; output: OutputFrom<TMachine>; snapshot: SnapshotFrom<TMachine> }
  | { status: "idle"; snapshot: SnapshotFrom<TMachine> }
  | {
      status: "error";
      cause: AgentRunErrorCause;
      error: unknown;
      snapshot: SnapshotFrom<TMachine>;
    };

export type AgentRunResult<TMachine extends AnyStateMachine> = AgentRunOutcome<TMachine> & {
  /**
   * The complete, self-contained replayable log for this run — the resumed
   * prefix (if any) plus every entry this run appended, starting with the
   * reserved `@agent.init` entry. Pass it back as
   * {@link AgentRunStart.events} to resume; fold it with
   * `getUsageFromEvents` for cumulative spend; hand it to `replay` for
   * crash recovery or time travel.
   */
  events: AgentLogEntry[];
  /**
   * Returns XState's persisted snapshot while the run-owned actor is still
   * available, including active child state. Store this value and pass it back
   * as `snapshot` to resume. Persistence, migration, and retries remain XState
   * and host responsibilities.
   *
   * The returned object carries an {@link AgentRunMeta} stamp under
   * `agentMeta`, naming the log position it caches — that is what lets a resume
   * skip replaying the log. Only the persisted object is stamped; the live
   * `snapshot` on the result is untouched.
   */
  persist(): Snapshot<unknown>;
  /**
   * Resolves once every {@link AgentRuntimeOptions.store} write issued so far has
   * landed — including a straggler `@agent.usage` entry appended by a call
   * that settled after the run returned, which the result itself does not wait
   * for. Await it before terminating the process if those entries matter.
   * Resolves immediately when the run has no store, and never rejects: a
   * failed write settles the run with `cause: 'journal'` instead.
   */
  drain(): Promise<void>;
  /**
   * Aggregated model-call usage for THIS run — `modelCalls` plus the token
   * fields every executor reported (see {@link AgentUsage} for the
   * partial-sum rule). Present on all three variants: an `idle` or `error`
   * result accounts for the calls made before the run settled.
   *
   * A resumed run counts only its own calls, not the history behind
   * `snapshot`.
   */
  usage: AgentUsage;
  /**
   * The {@link AgentRunInit.event} the machine did not handle: present only
   * when the resumed state had no transition for it, so sending it was a
   * no-op (no state change, no actions). The run settles normally — usually
   * back to `idle` at the same state — and the event is still journaled, so a
   * replay ignores it again.
   *
   * A host that wants to tell the client nothing happened checks this instead
   * of an error:
   *
   * ```ts
   * if (result.ignored) {
   *   return Response.json({ error: `'${result.ignored.type}' does not apply here` }, { status: 409 });
   * }
   * ```
   */
  ignored?: EventObject;
};

/**
 * Discriminates a {@link AgentRunResult} `error`:
 * - `'aborted'` — the run's `signal` fired.
 * - `'max-model-calls'` — the `maxModelCalls` budget was exceeded.
 * - `'decision-exhausted'` — the machine reached an error state whose error is
 *   (or wraps) a {@link AgentDecisionExhaustedError} that no `onError` handled.
 * - `'machine'` — any other machine error state.
 * - `'stopped'` — the actor was stopped externally (`status === 'stopped'`).
 * - `'journal'` — a {@link AgentRuntimeOptions.store} write rejected (a concurrent
 *   writer's {@link AgentEventLogConflictError}, or any other storage failure).
 */
export type AgentRunErrorCause =
  | "aborted"
  | "max-model-calls"
  | "decision-exhausted"
  | "machine"
  | "stopped"
  | "journal";

let nextRunAgentTraceId = 1;

/**
 * Thrown into the invoke that would have made the call once
 * {@link AgentRuntimeOptions.maxModelCalls} is spent. It reaches the machine
 * through the normal error channel, so an invoke's `onError` can branch on it
 * (`error.code === 'max-model-calls'`, the same string the settled result's
 * `cause` uses) and route to a degraded/finish state instead of failing the
 * run. Unhandled, it settles `{ status: 'error', cause: 'max-model-calls' }`.
 *
 * ```ts
 * onError: [
 *   { guard: ({ event }) => event.error?.code === 'max-model-calls', target: 'budgetSpent' },
 *   { target: 'failed' },
 * ]
 * ```
 */
export class AgentMaxModelCallsExceededError extends AgentError {
  /** The budget that was exceeded (`options.maxModelCalls`). */
  readonly maxModelCalls: number;
  constructor(maxModelCalls: number) {
    super(
      "max-model-calls",
      `The run exceeded maxModelCalls (${maxModelCalls}). Raise the budget, or handle it ` +
        `in the invoke's onError (error.code === 'max-model-calls').`,
    );
    this.name = "AgentMaxModelCallsExceededError";
    this.maxModelCalls = maxModelCalls;
  }
}

// True when `error` is a AgentDecisionExhaustedError or wraps one via its `cause`
// chain (an onError re-throw, or a machine error that carries the original as
// its cause). Bounded so a cyclic cause chain can't loop forever.
function wrapsDecisionExhausted(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 10 && current != null; depth++) {
    if (current instanceof AgentDecisionExhaustedError) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Recursively collects every invoke's `src` from raw machine config (spike
 * S6: `machine.config` preserves authored srcs; the built `machine.root`
 * normalizes object srcs to synthetic string ids and loses the distinction
 * this walk needs). Function-valued `src` resolvers are dynamic and are not
 * statically analyzable, so they are skipped (pass-through, like any other
 * non-agent actor).
 */
function collectConfiguredInvokeSrcs(
  stateConfig: { states?: Record<string, any>; invoke?: unknown } | undefined,
  stateName: string,
  out: Array<{ stateName: string; src: string | AnyActorLogic }>,
): void {
  if (!stateConfig) {
    return;
  }

  const invokes =
    stateConfig.invoke === undefined
      ? []
      : Array.isArray(stateConfig.invoke)
        ? stateConfig.invoke
        : [stateConfig.invoke];

  for (const invokeConfig of invokes) {
    const src = (invokeConfig as { src?: unknown } | undefined)?.src;
    if (typeof src === "string" || (src && typeof src === "object")) {
      out.push({ stateName, src: src as string | AnyActorLogic });
    }
    // Function-valued `src` resolvers are dynamic; not walked (see above).
  }

  for (const [childName, childConfig] of Object.entries(stateConfig.states ?? {})) {
    collectConfiguredInvokeSrcs(childConfig, `${stateName}.${childName}`, out);
  }
}

/**
 * Duck-types a state machine actor logic (an invoked child machine) vs. any
 * other actor logic. xstate's `StateMachine` carries `.config`, `.root`, and
 * a `.provide(...)` method plus a `sources.actors` map — this
 * combination is unique to machines and survives the dual-package/version
 * boundary an `instanceof` check would not. Used to descend the bind-time
 * walk into invoked child machines (their internal agent requests are opaque
 * to the parent-level source walk otherwise).
 */
export function isStateMachineLogic(logic: unknown): logic is AnyStateMachine {
  return (
    !!logic &&
    typeof logic === "object" &&
    "config" in logic &&
    "root" in logic &&
    typeof (logic as { provide?: unknown }).provide === "function" &&
    typeof (logic as { sources?: unknown }).sources === "object" &&
    !!(logic as { sources?: { actors?: unknown } }).sources?.actors
  );
}

/**
 * Fails fast (throws) at bind time — before any actor runs — when the
 * machine invokes an agent actor the runtime cannot execute. See §3.2 point 2.
 *
 * Recurses into invoked child state machines (arbitrarily deep). A child
 * machine's agent requests reached through string-keyed invoke srcs DO inherit
 * the parent run's `generateText`/`streamText`/`decide` executors —
 * the runtime rebinds them with the same host-backed wrappers (see
 * {@link rebindChildMachine}) — so the only remaining bind-time errors are: a
 * required executor kind missing entirely (naming the invoke chain and src),
 * and an unbound request reached through a direct-object invoke src that can't
 * be rebound ({@link unrebindableChildRequestError}). A request that carries
 * its own executor (`.withExecutor(...)`, tracked in `executorBoundLogics`)
 * always runs itself; explicit binding shadows inheritance.
 */
function assertBindable(
  machine: AnyStateMachine,
  effectiveSources: Record<string, AnyActorLogic>,
  executors: Partial<AgentRequestExecutors>,
): void {
  assertMachineBindable(machine, effectiveSources, executors, {
    isChild: false,
    childPath: "",
    rebindable: true,
    visited: new Set([machine]),
  });
}

/** Recursion frame for {@link assertBindable}. `isChild` flips the error
 * messages to name the child invoke chain; `childPath` names that chain
 * (`parent > child`); `rebindable` is true while every link back to the root
 * is a string-keyed source (so the runtime can rebind the request with its own
 * executors) and false once a direct-object invoke src is crossed (those
 * cannot be swapped via `.provide`, so an unbound request under one must
 * carry its own executor); `visited` guards against a machine invoking itself
 * recursively. */
interface BindWalkContext {
  isChild: boolean;
  childPath: string;
  rebindable: boolean;
  visited: Set<AnyStateMachine>;
}

function assertMachineBindable(
  machine: AnyStateMachine,
  effectiveSources: Record<string, AnyActorLogic>,
  executors: Partial<AgentRequestExecutors>,
  ctx: BindWalkContext,
): void {
  const invokes: Array<{ stateName: string; src: string | AnyActorLogic }> = [];
  collectConfiguredInvokeSrcs(machine.config as never, machine.config.id ?? "(root)", invokes);

  const where = ctx.isChild ? `child machine '${ctx.childPath}' state` : "state";

  for (const { stateName, src } of invokes) {
    if (typeof src !== "string") {
      // Direct-object src.
      if (isStateMachineLogic(src)) {
        assertChildMachineBindable(src, src, stateName, executors, ctx);
        continue;
      }
      // string-keyed sources can be rebound by the runtime; direct objects
      // cannot. Only a problem if it's an agent logic that still needs
      // execution (no executor of its own).
      if ((isTextLogic(src) || isDecisionLogic(src)) && !executorBoundLogics.has(src as object)) {
        throw new Error(
          `createAgentRuntime: ${where} '${stateName}' invokes a direct-object actor logic ` +
            `(kind: '${(src as TextLogic | DecisionLogic).kind}'). Direct-object invoke ` +
            `srcs cannot be rebound by the agent runtime — either call '.withExecutor(...)' on ` +
            `the logic before invoking it, or register it as a string-keyed actor ` +
            `source instead (machine.provide({ actors: { name: logic } })) and ` +
            `invoke it by name.`,
        );
      }
      continue;
    }

    const logic = effectiveSources[src];

    if (logic === undefined) {
      throw new Error(
        `createAgentRuntime: ${where} '${stateName}' invokes unregistered actor source '${src}'. ` +
          `Provide it via machine.provide({ actors: { '${src}': ... } }) or ` +
          `createAgentRuntime(machine, { actors: { '${src}': ... } }).`,
      );
    }

    if (isStateMachineLogic(logic)) {
      assertChildMachineBindable(logic, src, stateName, executors, ctx);
      continue;
    }

    if (isDecisionLogic(logic)) {
      // A decision source with its own bound executor runs itself.
      if (executorBoundLogics.has(logic as object)) {
        continue;
      }
      // Reachable only under a direct-object invoke src that can't be rebound.
      if (!ctx.rebindable) {
        throw unrebindableChildRequestError(ctx.childPath, stateName, src, "decision");
      }
      if (!executors.decide) {
        throw new Error(
          `createAgentRuntime: ${where} '${stateName}' invokes decision source '${src}' but no ` +
            `'decide' executor was provided to createAgentRuntime(...).`,
        );
      }
      continue;
    }

    if (isTextLogic(logic)) {
      // A text source with its own bound executor (`.withExecutor(...)`) needs
      // no host executor — it runs itself.
      if (executorBoundLogics.has(logic as object)) {
        continue;
      }
      // Reachable only under a direct-object invoke src that can't be rebound.
      if (!ctx.rebindable) {
        throw unrebindableChildRequestError(
          ctx.childPath,
          stateName,
          src,
          logic.mode === "stream" ? "streaming text" : "text",
        );
      }
      if (logic.mode === "stream" && !executors.streamText) {
        throw new Error(
          `createAgentRuntime: ${where} '${stateName}' invokes streaming text source '${src}' but ` +
            `no 'streamText' executor was provided to createAgentRuntime(...).`,
        );
      }
      if (logic.mode !== "stream" && !executors.generateText) {
        throw new Error(
          `createAgentRuntime: ${where} '${stateName}' invokes text source '${src}' but ` +
            `no 'generateText' executor was provided to createAgentRuntime(...).`,
        );
      }
      continue;
    }

    if (isUnboundPlaceholder(logic)) {
      throw new Error(
        `createAgentRuntime: ${where} '${stateName}' invokes actor source '${src}', which has no ` +
          `host execution. Provide it via machine.provide({ actors: { '${src}': ... } }) ` +
          `or createAgentRuntime(machine, { actors: { '${src}': ... } }).`,
      );
    }

    // Non-agent actor (real run fn) — passes through untouched.
  }
}

/** Descends the bind-time walk into an invoked child state machine, guarding
 * against a machine that (transitively) invokes itself. */
function assertChildMachineBindable(
  childMachine: AnyStateMachine,
  childSrc: string | AnyActorLogic,
  stateName: string,
  executors: Partial<AgentRequestExecutors>,
  ctx: BindWalkContext,
): void {
  // Cycle guard: a machine invoked (transitively) within itself is walked
  // once. Its own bind check already covered its invokes; re-descending would
  // loop forever.
  if (ctx.visited.has(childMachine)) {
    return;
  }

  const childName =
    typeof childSrc === "string" ? childSrc : (childMachine.config.id ?? "(child machine)");
  const childPath = ctx.childPath ? `${ctx.childPath} > ${childName}` : childName;

  const childSources = childMachine.sources.actors as Record<string, AnyActorLogic>;

  // A child is rebindable only when it is reached through string-keyed invoke
  // srcs all the way from the root: those can be swapped via `.provide`, so
  // the runtime rebinds the child's unbound requests with its own executors. A
  // direct-object invoke src (typeof childSrc !== "string") can't be swapped,
  // so nothing under it inherits.
  const rebindable = ctx.rebindable && typeof childSrc === "string";

  assertMachineBindable(childMachine, childSources, executors, {
    isChild: true,
    childPath,
    rebindable,
    visited: new Set([...ctx.visited, childMachine]),
  });
}

/** The loud bind-time error for an unbound agent request reached under a
 * direct-object invoke src, which the runtime cannot rebind (only string-keyed
 * sources can be swapped via `.provide`). Names the invoke chain AND the
 * request src, and spells out the `.withExecutor`/string-keyed remedy. Note:
 * requests reachable through string-keyed srcs at any depth DO inherit
 * the runtime's executors — this error is only for the unrebindable direct-object
 * case. */
function unrebindableChildRequestError(
  childPath: string,
  stateName: string,
  requestSrc: string,
  kind: "text" | "streaming text" | "decision",
): Error {
  return new Error(
    `createAgentRuntime: child machine '${childPath}' (state '${stateName}') invokes ${kind} ` +
      `source '${requestSrc}', which has no host execution and is reached through a ` +
      `direct-object invoke src that the agent runtime cannot rebind. Requests reached through ` +
      `string-keyed actor sources inherit the agent runtime's generateText/streamText/decide ` +
      `executors automatically; a direct-object child machine does not. Either bind the ` +
      `request with its own executor (requestLogic.withExecutor(...)), or register the ` +
      `child as a string-keyed actor source (machine.provide({ actors: { <child>: ` +
      `childMachine } })) and invoke it by name.`,
  );
}

/** Attribution a call site attaches to the reserved `@agent.usage` event it reports — everything on {@link AgentUsageEvent} except the type and the tokens. @internal */
type AgentUsageEventSource = Omit<AgentUsageEvent, "type" | "usage">;

// Shared state closed over by every wrapped actor source in one run: executors, observation callbacks, and the shared model-call budget/actor ref.
/** @internal */
interface RunAgentBindContext {
  generateText?: AgentRequestExecutor;
  streamText?: AgentRequestExecutor;
  decide?: AgentDecisionExecutor;
  /**
   * The single observation dispatch point (see {@link createTraceDispatch}):
   * the shared emission helpers hand it a bare {@link AgentTraceEventPayload}
   * plus the emitting actor's `self` (the invoked async leaf), and it fans out
   * to the trace sink and to the sugar callbacks derived from that payload.
   * `createAgentRuntime` ignores `self` and stamps a run-scoped envelope;
   * `provideExecutors` uses it to mint a per-root-actor envelope (see
   * `provideTraceSink`). Undefined when nothing observes.
   */
  emitTrace?: TraceDispatch;
  consumeModelCall: () => void;
  /**
   * Folds one completed call's reported usage into the run-level
   * {@link AgentUsage} AND — when the machine declares a transition for it —
   * delivers the reserved {@link AGENT_USAGE_EVENT_TYPE} event carrying
   * `usage` plus `source` as attribution.
   *
   * `self` is the settling request's own actor ref; the `provideExecutors`
   * path reads the invoking machine actor off it (`self._parent`) because it
   * has no run-scoped root actor. `createAgentRuntime` ignores it and delivers to the
   * run's root.
   */
  recordUsage?: (
    usage: AgentCallUsage,
    source?: AgentUsageEventSource,
    self?: BoundActorSelf,
  ) => void;
  /** The owning run's id (`run_<n>`), threaded to executors as `info.runId`. Unset off the runtime path. */
  runId?: string;
  /**
   * Mints the per-call idempotency key threaded to executors as
   * `info.callKey` (`${executionId}:${siteId}#${n}`). Memoized per invoked
   * leaf actor (`self`), so every attempt of one decision invoke shares this
   * invoke-level key; the decision wrap appends the attempt ordinal
   * (`…#${n}.${attempts.length}`) so retries do not collide in a cache.
   * Unset off the runtime path, and when the log has no `executionId`.
   */
  callKey?: (siteId: string, self?: object) => string | undefined;
  /**
   * The write-ahead barrier: awaited immediately before every text/decision
   * executor invocation, so no paid call is made against a log that is not yet
   * durable. Resolves immediately when the run has no
   * {@link AgentRuntimeOptions.store}; rejects with the journal's failure once a
   * write has rejected. Unset off the runtime path.
   */
  awaitJournal?: () => Promise<void>;
  /** Assigned right after createActor (§2.6); read lazily by decision wraps. */
  actorHolder: { actorRef: AnyActorRef | undefined };
  /** Registered `setupAgent` schemas (for event `inputSchema`s), if any. */
  schemas?: AgentSchemas;
}

/**
 * True when the snapshot's active states declare a transition that would
 * receive the reserved `'@agent.usage'` type — an explicit `on: { '@agent.usage'
 * }` OR a catch-all `on: { '*': … }`. Plain XState semantics apply unmodified:
 * a wildcard matches every event delivered to the machine, reserved ones
 * included. (The MODEL-facing side stays closed: `getAcceptedEvents` drops
 * `@agent.*` before any `allowedEvents` matching, so a wildcard never offers
 * the reserved event as a decision candidate.) @internal
 */
function declaresUsageTransition(snapshot: AnyMachineSnapshot): boolean {
  return getNextTransitions(snapshot).some(
    (transition) => transition.eventType === AGENT_USAGE_EVENT_TYPE || transition.eventType === "*",
  );
}

/**
 * The invoked async leaf's own actor ref, as the bind helpers below read it:
 * xstate types `self` on execute args as `unknown`, so it is cast to this once
 * at each entry point (the two wrappers) and stays typed from there on. Beyond
 * a plain ref it carries the parent link (the invoking machine actor) and the
 * durable invoke `src`. @internal
 */
type BoundActorSelf = AnyActorRef & { id?: string; _parent?: AnyActorRef; src?: string };

/** The single observation dispatch point built by {@link createTraceDispatch}. @internal */
type TraceDispatch = (payload: AgentTraceEventPayload, self?: BoundActorSelf) => void;

/** The observers a {@link TraceDispatch} fans one trace payload out to. @internal */
interface TraceSinks {
  /** Envelope-stamping trace sink (run-scoped on the runtime path, per-root-actor on the provide path). */
  onTrace?: (payload: AgentTraceEventPayload, self?: BoundActorSelf) => void;
  onChunk?: (chunk: string, info: { request: AgentRequest }) => void;
  onResult?: (request: AgentStepRequest, result: { result: unknown; raw: unknown }) => void;
  onTransition?: (
    snapshot: SnapshotFrom<AnyStateMachine>,
    event: EventFromLogic<AnyStateMachine>,
  ) => void;
}

/**
 * Builds the ONE place a trace payload is emitted: it hands the payload to the
 * envelope-stamping trace sink and, from that same payload, invokes the sugar
 * callbacks that are projections of it — {@link AgentRuntimeOptions.onChunk},
 * {@link AgentRuntimeOptions.onResult}, {@link AgentRuntimeOptions.onTransition}. Each
 * keeps its historical position relative to the trace: `onResult` fires just
 * BEFORE its `request.end`, `onChunk`/`onTransition` just AFTER their
 * `stream.chunk`/`machine.transition`. Sugar dispatch never depends on whether
 * a trace sink is present, and the trace sink is never called when it is
 * absent — so an `onTrace`-less run still mints no envelope (and advances no
 * `seq`). @internal
 */
function createTraceDispatch(sinks: TraceSinks): TraceDispatch {
  return (payload, self) => {
    switch (payload.type) {
      case "stream.chunk":
        sinks.onTrace?.(payload, self);
        sinks.onChunk?.(payload.chunk, { request: payload.request });
        return;
      case "request.end":
        sinks.onResult?.(payload.request, { result: payload.output, raw: payload.raw });
        sinks.onTrace?.(payload, self);
        return;
      case "machine.transition":
        sinks.onTrace?.(payload, self);
        sinks.onTransition?.(payload.snapshot, payload.event);
        return;
      default:
        sinks.onTrace?.(payload, self);
    }
  };
}

/** Reads the durable invoke id/src off the async actor's own ref (`self`). */
function selfIdAndSrc(self: BoundActorSelf | undefined): { id: string; src: string } {
  return {
    id: typeof self?.id === "string" ? self.id : "",
    src: typeof self?.src === "string" ? self.src : "",
  };
}

/**
 * The machine actor that INVOKED a decision request — the actor whose
 * live snapshot supplies the candidate events and drives `canTake`/`send`.
 * For a top-level request this is the root actor (identity-equal to
 * `runCtx.actorHolder.actorRef`); for a request inside an invoked child
 * machine it is that child's actor, so a child decision reads and drives
 * the CHILD's snapshot — not the root's. Read off `self._parent`, with the
 * root actor as a fallback.
 */
function invokingActorOf(
  self: BoundActorSelf | undefined,
  runCtx: RunAgentBindContext,
): AnyActorRef | undefined {
  const parent = self?._parent as (AnyActorRef & { _parent?: unknown }) | undefined;
  // A request inside an invoked child machine reads and drives that child.
  if (parent !== undefined && parent._parent !== undefined) {
    return parent;
  }
  // A top-level request reads the run's root. Under the agent loop every root
  // transition is pure, so `_parent` is the root AS OF the transition that
  // spawned the request; the run's facade reads the root as it is now.
  return runCtx.actorHolder.actorRef ?? parent;
}

/**
 * The shared text/stream emission helper: binds a {@link TextLogic} to
 * `runCtx`'s executor and constructs the `request.start` / `stream.chunk` /
 * `request.end` (incl. the lifted `reasoning`) / `request.error` trace payloads.
 * Used by both `createAgentRuntime` and `provideExecutors` so the two paths produce
 * identical event shapes by construction. @internal
 */
function bindTextLogic(logic: TextLogic, runCtx: RunAgentBindContext): TextLogic {
  return logic.withExecutor(async ({ request: rawRequest, self: selfArg, signal }) => {
    const self = selfArg as BoundActorSelf | undefined;
    const { id, src } = selfIdAndSrc(self);
    // A request authored with no `name` (bare `createTextLogic({ model })`)
    // takes its `actors:` registration key: the invoke `src` IS the
    // developer-facing handle, so name-addressed surfaces (runSeam's
    // `{ request }`, script routing, host mocks) work without a `name` in the
    // config. The `agent.*` builtins keep their documented nameless requests —
    // their `src` is the builtin id, not a handle the author chose.
    const request: AgentTextRequest = {
      ...rawRequest,
      name:
        rawRequest.name ??
        (src !== "" && src !== GENERATE_TEXT_ACTOR && src !== STREAM_TEXT_ACTOR ? src : id || src),
    };
    const executor = logic.mode === "stream" ? runCtx.streamText : runCtx.generateText;
    if (!executor) {
      throw new Error(
        `No '${logic.mode === "stream" ? "streamText" : "generateText"}' ` + "executor provided.",
      );
    }

    const requestWithTools: AgentTextRequest & { tools: AgentTools } = {
      ...request,
      tools: request.tools ?? {},
    };
    const agentRequest: AgentRequest = {
      kind: "text",
      id,
      src,
      mode: logic.mode,
      input: request,
      tools: requestWithTools.tools,
      events: [],
    };

    runCtx.consumeModelCall();
    runCtx.emitTrace?.({ type: "request.start", request: agentRequest }, self);
    try {
      const callKey = id !== "" ? runCtx.callKey?.(id, self) : undefined;
      // Write-ahead: the log up to this point must be durable before the call.
      await runCtx.awaitJournal?.();
      const raw = await executor(requestWithTools as AgentExecutorTextRequest, {
        onChunk: (chunk: string) => {
          runCtx.emitTrace?.({ type: "stream.chunk", request: agentRequest, chunk }, self);
        },
        signal,
        ...(runCtx.runId !== undefined ? { runId: runCtx.runId } : {}),
        ...(id !== "" ? { requestId: id } : {}),
        ...(callKey !== undefined ? { callKey } : {}),
      });
      const output = await normalizeGeneratorResult(raw, id);

      // Lift `reasoning` off the raw executor result (the provider output's
      // opt-in field) onto the request.end trace — never into machine output.
      const rawReasoning = (raw as { reasoning?: unknown } | null | undefined)?.reasoning;
      const reasoning = typeof rawReasoning === "string" ? rawReasoning : undefined;

      // Fold this call's reported tokens into the run-level AgentUsage, and
      // surface them per-call on the request.end trace.
      const usage = getCallUsage(raw);
      const finishReason = getCallFinishReason(raw);
      if (usage) {
        runCtx.recordUsage?.(
          usage,
          {
            kind: "text",
            ...(id !== "" ? { id } : {}),
            ...(src !== "" ? { src } : {}),
            model: request.model,
            ...(request.name !== undefined ? { name: request.name } : {}),
          },
          self,
        );
      }

      runCtx.emitTrace?.(
        {
          type: "request.end",
          request: agentRequest,
          output,
          raw,
          ...(reasoning !== undefined ? { reasoning } : {}),
          ...(usage !== undefined ? { usage } : {}),
          ...(finishReason !== undefined ? { finishReason } : {}),
        },
        self,
      );

      return { result: output, messages: responseMessagesOf(raw) };
    } catch (error) {
      runCtx.emitTrace?.({ type: "request.error", request: agentRequest, error }, self);
      throw error;
    }
  });
}

// Wraps runCtx's `decide` executor with model-call budgeting and tracing.
// `self` is the invoking decision leaf actor, threaded to `onTrace` so the
// provide path can attribute the event to its root actor.
function createCountingDecide(
  runCtx: RunAgentBindContext,
  self: BoundActorSelf | undefined,
): AgentDecisionExecutor {
  return async (attemptRequest, info) => {
    runCtx.consumeModelCall();
    runCtx.emitTrace?.({ type: "request.start", request: attemptRequest }, self);
    try {
      const { id } = selfIdAndSrc(self);
      // The invoke-level key is memoized on `self`, so every attempt of this
      // decision shares it — but each attempt is a DISTINCT paid call with a
      // different request (the rejected attempts ride along as feedback), so
      // the attempt ordinal is appended: `…#<n>.<attempt>`. Without it a
      // compliant idempotency cache would replay the rejected first attempt
      // for every retry. The ordinal comes from `request.attempts.length`, so
      // a crash re-executing attempt k derives the same key again.
      const invokeCallKey = id !== "" ? runCtx.callKey?.(id, self) : undefined;
      const callKey =
        invokeCallKey === undefined
          ? undefined
          : `${invokeCallKey}.${attemptRequest.attempts?.length ?? 0}`;
      // Write-ahead: the log up to this point must be durable before the call.
      await runCtx.awaitJournal?.();
      // `runId` rides on the request like `signal` does: host-injected
      // correlation, never serialized into machine state. It also rides on the
      // `info` second argument, where generateText/streamText carry it.
      const result = await runCtx.decide!(
        runCtx.runId !== undefined ? { ...attemptRequest, runId: runCtx.runId } : attemptRequest,
        {
          ...info,
          ...(runCtx.runId !== undefined ? { runId: runCtx.runId } : {}),
          ...(info?.requestId === undefined && id !== "" ? { requestId: id } : {}),
          ...(info?.callKey === undefined && callKey !== undefined ? { callKey } : {}),
        },
      );
      const usage = getCallUsage(result);
      const finishReason = getCallFinishReason(result);
      if (usage) {
        const { src } = selfIdAndSrc(self);
        runCtx.recordUsage?.(
          usage,
          {
            kind: "decision",
            ...(attemptRequest.id ? { id: attemptRequest.id } : {}),
            ...(src !== "" ? { src } : {}),
            model: attemptRequest.model,
          },
          self,
        );
      }
      runCtx.emitTrace?.(
        {
          type: "request.end",
          request: attemptRequest,
          output: result.event,
          raw: result,
          ...(usage !== undefined ? { usage } : {}),
          ...(finishReason !== undefined ? { finishReason } : {}),
        },
        self,
      );
      return result;
    } catch (error) {
      runCtx.emitTrace?.({ type: "request.error", request: attemptRequest, error }, self);
      throw error;
    }
  };
}

/**
 * Builds the decision actor logic the runtime installs in place of a
 * `DecisionLogic`/`agent.decide` source. `DecisionLogic.withExecutor(...)`
 * can only swap the innermost per-attempt executor — the `resolveDecision(...)`
 * call (and its `canTake`) is hardwired inside the original logic's `run`.
 * To supply `canTake` (mode-3, §2.6), the runtime instead builds a fresh async
 * logic here that calls `resolveDecision` itself, reusing `logic.request(...)`
 * to build the request the same way the original logic would have.
 *
 * On success it SENDS the chosen event to the invoking actor (auto-delivery)
 * and then completes with that event
 * as its output — so callers never wire an `onDone` to deliver it. See the
 * send-then-complete note inside `run` for how exit-cancels-invoke interacts
 * with `onDone`.
 */
function bindDecisionLogic(logic: DecisionLogic, runCtx: RunAgentBindContext): DecisionLogic {
  const decisionLogic = createAsyncLogic<ChosenEvent, unknown>({
    run: async ({ input, signal, self: selfArg }) => {
      if (!runCtx.decide) {
        throw new Error("No 'decide' executor provided.");
      }
      const self = selfArg as BoundActorSelf | undefined;
      const { id } = selfIdAndSrc(self);

      // Rebuild the candidate events from the live snapshot (mirrors the
      // STEP path's getAgentRequests, §2.7): `undefined` declared
      // allowedEvents means "all currently-legal events," not "none" — do
      // not trust logic.request(...).events here, it defaults omitted to [].
      const declaredEventTypes = (
        logic as unknown as {
          allowedEventTypes?: (input: unknown) => readonly string[] | undefined;
        }
      ).allowedEventTypes?.(input);

      // xstate's actor `_process` executes an invoke's spawn effect (which
      // starts this async logic's `run`, synchronously through its first
      // `await`) BEFORE calling `update()` to commit the new snapshot — so
      // `actorRef.getSnapshot()` read at the very top of `run` observes the
      // PRE-transition snapshot (e.g. still `awaitingAnswer` instead of the
      // `deciding` state that invoked this decision). Yielding one microtask
      // lets `update()` finish first, so the read below sees the committed,
      // current snapshot.
      await Promise.resolve();
      const actorRef = invokingActorOf(self, runCtx);
      const events = actorRef
        ? getAcceptedEvents(actorRef.getSnapshot() as AnyMachineSnapshot, {
            schemas: runCtx.schemas,
            eventTypes: declaredEventTypes,
          })
        : [];

      const lowered = logic.request(input as never);
      const request: AgentDecisionRequest = {
        ...lowered,
        id,
        name: lowered.name ?? id,
        input,
        events,
      };

      const chosen = await resolveDecision(
        request,
        { decide: createCountingDecide(runCtx, self) },
        {
          maxRetries: logic.maxRetries,
          signal,
          canTake: (event) =>
            actorRef ? (actorRef.getSnapshot() as AnyMachineSnapshot).can(event) : true,
        },
      );

      // Auto-deliver: send the chosen event to the invoking actor, then
      // complete with it as output. The delivered event's transition typically
      // EXITS the invoking state, which cancels this invoke — so `onDone` never
      // fires on that path. If the transition stays in-state instead, the invoke completes and `onDone` (if any) observes
      // `chosen` as its output. The send happens in this actor's own async
      // `run` — not a re-evaluated transition function — so it fires exactly
      // once regardless of v6-alpha transition re-evaluation.
      actorRef?.send(chosen as never);
      // Let the applied transition commit (and let xstate cancel this invoke if
      // the event exited the state) before completing.
      await Promise.resolve();

      return chosen;
    },
  });

  return Object.assign(decisionLogic, {
    kind: "statelyai.decisionLogic" as const,
    maxRetries: logic.maxRetries,
    request: logic.request,
    withExecutor: (nextExecute: AgentDecisionExecutor) =>
      bindDecisionLogic(logic.withExecutor(nextExecute), runCtx),
  }) as DecisionLogic;
}

/**
 * The set of string-keyed actor `src`s the machine's own config invokes
 * (top-level, recursing into child STATES but not into invoked child
 * machines). {@link provideExecutors} uses it to require an executor only for a
 * source the machine actually invokes — the always-registered `agent.*`
 * builtins that go unused must not force their executors to be supplied.
 * @internal
 */
export function getConfiguredInvokeSrcs(machine: AnyStateMachine): Set<string> {
  const invokes: Array<{ stateName: string; src: string | AnyActorLogic }> = [];
  collectConfiguredInvokeSrcs(machine.config as never, machine.config.id ?? "(root)", invokes);
  const srcs = new Set<string>();
  for (const { src } of invokes) {
    if (typeof src === "string") {
      srcs.add(src);
    }
  }
  return srcs;
}

// ─── Uncontrolled-path (provideExecutors) trace envelope ───
//
// `provideExecutors` binds a machine ONCE, but the returned machine can back
// many concurrent root actors. Envelope state (runId + monotonic seq) is
// therefore minted per ROOT actor at runtime and held in a module-level
// WeakMap, keyed on the root actor ref (walk `self._parent` to the top). Both
// the request-level trace (below) and {@link traceTransitions} read the same
// registry, so their events form ONE ordered `seq` stream per root actor.

interface RootTraceState {
  runId: string;
  seq: number;
  machineId: string;
  machineVersion: string;
}

const rootTraceRegistry = new WeakMap<object, RootTraceState>();
let nextProvideRunId = 1;

/** Walks `self._parent` from an invoked async leaf actor up to its root actor. */
function rootActorOf(self: BoundActorSelf | undefined): AnyActorRef | undefined {
  let ref = self;
  while (ref?._parent) {
    ref = ref._parent as BoundActorSelf;
  }
  return ref;
}

/** The per-root envelope state, minted on first use (runId `run_<n>`, matching the runtime). */
function rootTraceState(root: AnyActorRef): RootTraceState {
  let state = rootTraceRegistry.get(root as object);
  if (!state) {
    const logic = (root as { logic?: AnyStateMachine }).logic;
    const machineId =
      (logic?.config as { id?: string } | undefined)?.id ?? logic?.id ?? "(machine)";
    const machineVersion = logic ? resolveMachineVersion(logic) : "";
    state = { runId: `run_${nextProvideRunId++}`, seq: 0, machineId, machineVersion };
    rootTraceRegistry.set(root as object, state);
  }
  return state;
}

/** Stamps a per-root-actor envelope onto a bare trace payload. */
function stampRootTrace(root: AnyActorRef, payload: AgentTraceEventPayload): AgentTraceEvent {
  const state = rootTraceState(root);
  return {
    schemaVersion: AGENT_TRACE_SCHEMA_VERSION,
    runId: state.runId,
    seq: ++state.seq,
    timestamp: new Date().toISOString(),
    machineId: state.machineId,
    machineVersion: state.machineVersion,
    ...payload,
  } as AgentTraceEvent;
}

/** Adapts a public `onTrace` into the payload-level trace sink a {@link TraceDispatch} fans out to. */
function provideTraceSink(onTrace?: (event: AgentTraceEvent) => void): TraceSinks["onTrace"] {
  if (!onTrace) {
    return undefined;
  }
  return (payload, self) => {
    const root = rootActorOf(self);
    if (root) {
      onTrace(stampRootTrace(root, payload));
    }
  };
}

/** Options threaded into the `provideExecutors` bind helpers. @internal */
export interface ProvideBindOptions {
  onChunk?: (chunk: string) => void;
  onTrace?: (event: AgentTraceEvent) => void;
}

/**
 * A minimal {@link RunAgentBindContext} for `provideExecutors` (uncontrolled
 * `createActor`): the same wrappers the runtime installs, MINUS the run-scoped
 * model-call counter. `consumeModelCall` is a no-op (no budget), and
 * `actorHolder.actorRef` is left undefined — the wrappers read the invoking
 * actor off `self._parent`, always present under a live `createActor` tree.
 * `onTrace` (when given) mints a per-root-actor envelope. `schemas` come from
 * the machine's registered `setupAgent` execution options.
 *
 * `recordUsage` has no run-level aggregate to fold into here (there is no
 * run), so it does one thing: deliver the reserved `@agent.usage` event, gated
 * exactly like the runtime's — see {@link deliverUsageEvent}.
 */
function provideBindContext(
  machine: AnyStateMachine,
  executors: Partial<AgentRequestExecutors>,
  options: ProvideBindOptions,
): RunAgentBindContext {
  const traceSink = provideTraceSink(options.onTrace);
  const onChunk = options.onChunk;
  return {
    generateText: executors.generateText,
    streamText: executors.streamText,
    decide: executors.decide,
    // Built only when something observes, so a bare bind allocates no payloads.
    emitTrace:
      traceSink || onChunk
        ? createTraceDispatch({
            onTrace: traceSink,
            onChunk: onChunk ? (chunk) => onChunk(chunk) : undefined,
          })
        : undefined,
    consumeModelCall: () => {},
    recordUsage: (usage, source, self) => {
      deliverUsageEvent({ type: AGENT_USAGE_EVENT_TYPE, ...source, usage }, () => self?._parent);
    },
    actorHolder: { actorRef: undefined },
    schemas: getRegisteredAgentExecutionOptions(machine).schemas,
  };
}

/**
 * The single reserved-`@agent.usage` DELIVERY seam, shared by both bind paths:
 * after a bound call settles with reported usage, send the prebuilt `event` to
 * the machine actor `resolveActorRef` names — the run's root actor on the `createAgentRuntime` path,
 * the settling request actor's `self._parent` (always the invoking machine
 * under a live `createActor` tree) on the `provideExecutors` path.
 *
 * Journaling is separate and unconditional (see `recordUsage`): a call's tokens
 * are recorded in the event log whether or not the machine reacts to them.
 *
 * Gating is identical on both: the target snapshot must be active, must declare
 * an `'@agent.usage'` transition — explicitly, or through a catch-all
 * `on: { '*' }` (see {@link declaresUsageTransition}) — and must be able to
 * take the event. `onDropped` is the run path's straggler gate: it returns `true` for a
 * call that settled after the cycle resolved, which drops the event (traced as
 * `usage.dropped`) rather than delivering it. Uncontrolled mode has no cycle to
 * settle, so it passes no gate and has no dropped stragglers.
 *
 * Delivery follows each path's binding boundary: only sources IT bound report
 * here, so an invoked child machine that was not itself passed through
 * `provideExecutors` reports nothing. @internal
 */
function deliverUsageEvent(
  event: AgentUsageEvent,
  resolveActorRef: () => AnyActorRef | undefined,
  onDropped?: (event: AgentUsageEvent) => boolean,
): void {
  const actorRef = resolveActorRef();
  if (!actorRef) {
    return;
  }
  const snapshot = actorRef.getSnapshot() as AnyMachineSnapshot;
  if (snapshot?.status !== "active" || !declaresUsageTransition(snapshot)) {
    return;
  }
  if (onDropped?.(event)) {
    return;
  }
  if (!snapshot.can(event as never)) {
    return;
  }
  actorRef.send(event as never);
}

/**
 * Host-binds one text/stream source for {@link provideExecutors} using the SAME
 * emission helper as `createAgentRuntime` ({@link bindTextLogic}), so a bound
 * text request emits request.start/stream.chunk/request.end/request.error with
 * identical shapes. @internal
 */
export function bindTextForProvide(
  machine: AnyStateMachine,
  logic: TextLogic,
  executors: Partial<AgentRequestExecutors>,
  options: ProvideBindOptions,
): TextLogic {
  return bindTextLogic(logic, provideBindContext(machine, executors, options));
}

/**
 * Host-binds one `DecisionLogic`/`agent.decide` source for
 * {@link provideExecutors}: the runtime's decision wrapper (snapshot-driven
 * candidate events, `canTake`, auto-delivery of the chosen event) with the same
 * request-level tracing the runtime emits, minus run-scoped counting. @internal
 */
export function bindDecisionForProvide(
  machine: AnyStateMachine,
  logic: DecisionLogic,
  executors: Partial<AgentRequestExecutors>,
  options: ProvideBindOptions,
): DecisionLogic {
  return bindDecisionLogic(logic, provideBindContext(machine, executors, options));
}

/**
 * Recursively binds an invoked child state machine for {@link provideExecutors},
 * with the same semantics `createAgentRuntime` applies ({@link rebindChildMachine}):
 * string-keyed text/decision sources at any depth inherit the host executors,
 * a source that carries its own executor is left alone, and a cycle is
 * returned as-is. Each machine in the tree is bound with its own registered
 * `setupAgent` schemas. Returns the original machine when nothing needed
 * wrapping. @internal
 */
export function bindChildMachineForProvide(
  childMachine: AnyStateMachine,
  executors: Partial<AgentRequestExecutors>,
  options: ProvideBindOptions,
  visited: Set<AnyStateMachine>,
): AnyStateMachine {
  const ctxFor = (target: AnyStateMachine) => provideBindContext(target, executors, options);
  return rebindChildMachine(childMachine, ctxFor(childMachine), visited, ctxFor);
}

/**
 * The machine input a run accepts, which is the schema's *pre*-validation side.
 *
 * XState's `schemas` are types only — it never validates, and it resolves
 * `schemas.input` to one type shared by `createActor`'s `input` option and the
 * `context: ({ input })` factory. A schema field declared with a default
 * therefore reads as required at the call site even though the caller is meant
 * to omit it. `setupAgent` brands the machine's input type with its own schema
 * ({@link WithAgentInputSchema}), so this recovers the looser caller-facing
 * side while the factory keeps seeing the validated one. Machines with no
 * declared input schema — and machines reached through `.provide(...)`, which
 * drops the brand — fall back to xstate's `InputFrom`.
 */
export type AgentInputFrom<TMachine extends AnyStateMachine> =
  // `NonNullable` first: a machine whose input is optional resolves to
  // `<branded> | undefined`, and `undefined` never matches an object type, so
  // matching the union directly drops the brand and reports the validated
  // (defaults-required) side at the call site. The brackets keep the match
  // non-distributive.
  [NonNullable<InputFrom<TMachine>>] extends [WithAgentInputSchema<infer TInputSchema>]
    ? [TInputSchema] extends [StandardSchemaV1]
      ? InferInput<TInputSchema>
      : InputFrom<TMachine>
    : InputFrom<TMachine>;

/**
 * Validates `input` against the machine's registered input schema, returning
 * the schema's output — so defaults are filled and transforms applied before
 * the value reaches `createActor` or the replayable event log.
 *
 * Standard Schema only (no validation library is referenced), so this works for
 * whatever the machine was declared with. Omitted input stays omitted rather
 * than being validated as `{}`: "started with no input" keeps meaning what it
 * has always meant, instead of newly failing schemas with required fields.
 */
function resolveMachineInput(machine: AnyStateMachine, input: unknown): unknown {
  if (input === undefined) return input;
  const schema = getRegisteredAgentExecutionOptions(machine).schemas?.input;
  if (!isStandardSchema(schema)) return input;
  try {
    return validateSchemaSync(schema, input);
  } catch (error) {
    throw new AgentError(
      "invalid-machine-input",
      `createAgentRuntime: machine input failed validation against the declared input ` +
        `schema: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

/**
 * Recursively rebinds an invoked child machine's own agent sources with the
 * SAME host-backed wrappers the runtime applies to the top-level machine, so a
 * child's text/stream/decision requests inherit the runtime's executors and
 * participate in maxModelCalls counting, onTrace/onChunk/onResult exactly like
 * parent requests. Returns the child machine to invoke: a `.provide`-rebound
 * copy when any inner source needed wrapping, else the original untouched.
 *
 * Only string-keyed sources are visited — a direct-object invoke src cannot be
 * swapped via `.provide` (assertBindable already rejected an unbound request
 * under one). A source that already carries its own executor
 * (`executorBoundLogics`) is left as-is: explicit binding shadows inheritance.
 * Cycle-safe via `visited` (a machine that invokes itself is returned as-is).
 */
function rebindChildMachine(
  childMachine: AnyStateMachine,
  runCtx: RunAgentBindContext,
  visited: Set<AnyStateMachine>,
  /**
   * Optional per-machine bind-context factory. `createAgentRuntime` shares ONE run-scoped
   * context at every depth (one budget, one trace envelope, one root actor), so
   * it omits this. `provideExecutors` passes it so each machine in the tree is
   * bound with its OWN registered `setupAgent` schemas — a child decision must
   * validate against the child's event schemas, not the root's. @internal
   */
  ctxFor?: (machine: AnyStateMachine) => RunAgentBindContext,
): AnyStateMachine {
  if (visited.has(childMachine)) {
    return childMachine;
  }
  const childVisited = new Set([...visited, childMachine]);
  runCtx = ctxFor ? ctxFor(childMachine) : runCtx;
  const sources = childMachine.sources.actors as Record<string, AnyActorLogic>;
  const wrapped: Record<string, AnyActorLogic> = {};

  for (const [key, logic] of Object.entries(sources)) {
    if (isDecisionLogic(logic)) {
      if (!executorBoundLogics.has(logic as object)) {
        wrapped[key] = bindDecisionLogic(logic, runCtx);
      }
      continue;
    }
    if (isTextLogic(logic)) {
      if (!executorBoundLogics.has(logic as object)) {
        wrapped[key] = bindTextLogic(logic, runCtx);
      }
      continue;
    }
    if (isStateMachineLogic(logic)) {
      const rebound = rebindChildMachine(logic, runCtx, childVisited, ctxFor);
      if (rebound !== logic) {
        wrapped[key] = rebound;
      }
      continue;
    }
    // Non-agent actors and placeholders pass through untouched.
  }

  return Object.keys(wrapped).length > 0
    ? (childMachine.provide({ actors: wrapped as never }) as AnyStateMachine)
    : childMachine;
}

/**
 * The durable effects one transition produced. Hand them to
 * {@link AgentRuntime.execute}; nothing in them has run yet.
 */
export type AgentEffects = Parameters<DurableExecution<AnyStateMachine>["executeEffects"]>[0];

/**
 * Where a run's `after` timers live. The default (`"in-process"`) arms them
 * with `setTimeout` and counts a pending timer as work in flight, so a loop
 * keeps reading its mailbox until the timer fires. A host with its own
 * durable timers (a Temporal timer, a Durable Object alarm, an Inngest sleep)
 * passes `schedule`/`cancel`: the loop then treats a pending timer as the
 * outside world's business, and the host delivers `{ type: "xstate.timer", id }`
 * through {@link AgentRuntime.transition} when it fires.
 */
export type AgentTimerScheduler =
  | "in-process"
  | {
      schedule(timer: { id: string; delay: number }): void;
      cancel(id: string): void;
    };

/**
 * A host-owned timer firing: what a host with its own durable timers (see
 * {@link AgentTimerScheduler}) delivers when the `id` it was asked to
 * schedule comes due.
 */
export interface AgentTimerEvent {
  type: "xstate.timer";
  id: string;
}

/** How {@link AgentRuntime.start} opens a run. */
export interface AgentRunStart<TMachine extends AnyStateMachine> {
  /**
   * Machine input. Validated against the machine's declared input schema —
   * defaults filled, transforms applied — before it reaches
   * `createActor(machine, { input })`; invalid
   * input throws an {@link AgentError} with code `invalid-machine-input`.
   * Typed as {@link AgentInputFrom}, so fields the schema defaults are optional
   * here. Omit when resuming via `snapshot`.
   */
  input?: AgentInputFrom<TMachine>;
  /** A previously-settled run's `result.persist()`, to resume from instead of starting fresh. Pair with `event` to deliver the event that unblocks the resumed idle state. */
  snapshot?: Snapshot<unknown>;
  /**
   * A prior run's `result.events` — the replayable log to resume from and keep
   * appending to. THE LOG IS THE SOURCE OF TRUTH: journaled model/tool results
   * are folded back in rather than re-executed, so a crashed run resumes from
   * its log alone.
   *
   * A `snapshot` passed alongside is a CACHE of that log: it is trusted only
   * when it is stamped (see {@link AgentRunMeta}) at the log's current tail and
   * hashes to what the tail entry recorded; otherwise the log is replayed and
   * the cache is verified against the position it claims (a genuine
   * disagreement throws {@link AgentSnapshotDivergedError}).
   *
   * When the log was written by a DIFFERENT machine version, a `snapshot` is
   * required (XState's own `migrate` applies on restore) and the run starts a
   * NEW log segment whose init entry records where it bridged from; without one
   * it throws `AgentMachineVersionMismatchError`.
   */
  events?: readonly AgentLogEntry[];
}

/**
 * The agent loop's helpers for one run. The host owns the loop:
 *
 * ```ts
 * let [state, effects] = await runtime.start({ input });
 * await runtime.execute(effects);
 * for (let event; (event = await runtime.nextEvent()); ) {
 *   [state, effects] = runtime.transition(state, event);
 *   await runtime.execute(effects);
 * }
 * const result = await runtime.finish();
 * ```
 *
 * `execute` only starts work. Every completion, failure, child message and
 * timer lands in one mailbox, and `nextEvent` hands out whichever arrived
 * first. It resolves `undefined` once nothing but the outside world can move
 * the machine: no effect, child or timer is in flight and the mailbox is
 * empty (or the run finished, was cancelled, or lost its journal).
 *
 * "In flight" means any running child that is not a machine at rest: a model
 * request, an async actor, a child machine whose own children are running.
 * A callback or subscription child never finishes on its own, so while one
 * is running the loop keeps reading until it stops; a host that invokes one
 * for the life of a state should expect `nextEvent` to keep waiting there.
 */
export interface AgentRuntime<TMachine extends AnyStateMachine> {
  /** Opens the run: a fresh start from `input`, a resume from `snapshot`, or recovery from a log. */
  start(init?: AgentRunStart<TMachine>): Promise<[SnapshotFrom<TMachine>, AgentEffects]>;
  /** Applies one event: journals it, traces it, and returns the next state plus its effects. */
  transition(
    state: SnapshotFrom<TMachine>,
    event: EventFromLogic<TMachine> | AgentTimerEvent,
  ): [SnapshotFrom<TMachine>, AgentEffects];
  /** Starts the effects' work and returns once it is accepted, not once it finishes. */
  execute(effects: AgentEffects): Promise<void>;
  /** The next event that arrived, or `undefined` once the run is quiescent. */
  nextEvent(): Promise<EventFromLogic<TMachine> | undefined>;
  /** Settles the run: stops what is still running and returns the outcome. */
  finish(): Promise<AgentRunResult<TMachine>>;
}

/** How {@link runToQuiescence} opens a run: {@link AgentRunStart} plus one event to deliver. */
export interface AgentRunInit<TMachine extends AnyStateMachine> extends AgentRunStart<TMachine> {
  /**
   * An event to send immediately after starting/resuming the actor (e.g. the
   * human's answer to an idle-state prompt), typed as the machine's event
   * union. If the resumed state has no transition for it, the machine ignores
   * it — the run settles normally and the result carries
   * {@link AgentRunResult.ignored}. For a payload off the wire, parse it first
   * with `parseAgentEvent(machine, payload)`. A host-owned timer that came
   * due is delivered the same way, as an {@link AgentTimerEvent}.
   */
  event?: EventFromLogic<TMachine> | AgentTimerEvent;
}

/**
 * The blocking host: opens the run, delivers `event` if given, then applies
 * every event that arrives until the run is quiescent, and returns the
 * outcome. A request handler or durable engine writes the same loop with its
 * own stop policy; this one is for scripts and tests.
 */
export async function runToQuiescence<TMachine extends AnyStateMachine>(
  runtime: AgentRuntime<TMachine>,
  init: AgentRunInit<TMachine> = {},
): Promise<AgentRunResult<TMachine>> {
  let [state, effects] = await runtime.start(init);
  await runtime.execute(effects);
  if (init.event !== undefined && (state as AnyMachineSnapshot).status === "active") {
    [state, effects] = runtime.transition(state, init.event);
    await runtime.execute(effects);
  }
  for (let event; (event = await runtime.nextEvent());) {
    [state, effects] = runtime.transition(state, event);
    await runtime.execute(effects);
  }
  return runtime.finish();
}

/**
 * Entry-by-entry check that the caller's `events` IS the store's thread. Equal
 * lengths prove nothing: a fork, a rolled-back replay, or a concurrent writer
 * that appended and truncated all produce a divergent log of the same size,
 * and appending this run's entries onto it would splice two lineages together.
 */
function assertThreadMatchesEvents(
  threadId: string,
  stored: readonly AgentLogEntry[],
  events: readonly AgentLogEntry[],
): void {
  for (let index = 0; index < stored.length; index++) {
    const storedEntry = stored[index]!;
    const givenEntry = events[index]!;
    const storedHash = storedEntry.verification?.stateHash;
    const givenHash = givenEntry.verification?.stateHash;
    const same =
      storedEntry.id === givenEntry.id &&
      storedEntry.index === givenEntry.index &&
      canonicalEventJson(storedEntry.event) === canonicalEventJson(givenEntry.event) &&
      (storedHash === undefined || givenHash === undefined || storedHash === givenHash);
    if (!same) {
      throw new AgentError(
        "event-log-conflict",
        `createAgentRuntime: the given \`events\` diverge from thread "${threadId}" at index ${index} ` +
          `(stored entry '${storedEntry.id}', given '${givenEntry.id}') — ` +
          "the log passed in is not this thread's log.",
      );
    }
  }
}

/** Why a run stopped early, when it did (a cancel, or a journal that stopped being durable). */
type StopReason = { cause: "aborted" | "journal" | "machine"; error: unknown };

const QUIESCENT = Symbol("quiescent");

/**
 * Creates the helpers for one run of `machine`: executors bound to its
 * requests, the write-ahead log, traces, the budget, and a mailbox over
 * XState's durable transition loop (`xstate/durable`). See
 * {@link AgentRuntime} for the loop a host writes around it, and
 * {@link runToQuiescence} for the blocking host. {@link AgentRuntime.finish}
 * stops whatever is still running on every settle path (`done`, `idle`, and
 * `error` alike) — resume is always by snapshot (or log), never by holding a
 * reference to a live actor.
 *
 * Binding happens **before** any actor starts: every invoke the machine
 * could reach is walked and checked against the effective actor sources
 * (`options.actors` merged onto the machine), so a missing
 * `streamText`/`decide` executor or any other unbound actor source throws
 * synchronously from this call — a bind-time error, not a mid-run failure.
 *
 * @example
 * ```ts
 * const executors = createAiSdkExecutors({ models });
 * let r = await runToQuiescence(createAgentRuntime(machine, { executors }), { input });
 * while (r.status === 'idle') {
 *   const event = await promptUser(getAcceptedEvents(r.snapshot));
 *   r = await runToQuiescence(createAgentRuntime(machine, { executors }), {
 *     snapshot: r.snapshot,
 *     event,
 *   });
 * }
 * if (r.status !== 'done') throw new Error(`Run did not complete: ${r.status}`);
 * console.log(r.output);
 * ```
 *
 * Each executor is a plain function returning `{ result }` (plus optional `messages`/`usage`), or
 * an adapter's set: `createAiSdkExecutors` from '@statelyai/agent/ai-sdk' or
 * `createOpenAiExecutors` from '@statelyai/agent/openai' supply all three.
 */
export function createAgentRuntime<TMachine extends AnyStateMachine>(
  machine: TMachine,
  options: AgentRuntimeOptions<TMachine> = {},
): AgentRuntime<TMachine> {
  const maxModelCalls = options.maxModelCalls ?? 100;
  let modelCallCount = 0;
  let budgetExceeded = false;
  // Dev-only serialization guard: warn at most once per run when idle context
  // holds values that won't survive snapshot persist/resume (see finish).
  let warnedNonSerializable = false;
  const runId = `run_${nextRunAgentTraceId++}`;
  let traceSeq = 0;

  const machineId = (machine.config as { id?: string }).id ?? machine.id ?? "(machine)";
  // The machine's own `version` (XState's standard `createMachine({ version })`
  // prop, `.provide`-surviving) is the single source of truth; an unversioned
  // machine falls back to the structural hash.
  const machineVersion = resolveMachineVersion(machine);

  // The run's single observation dispatch point: every trace payload in this
  // run goes through `onTrace`, which stamps the run-scoped envelope for
  // `options.onTrace` and drives the sugar callbacks projected from the same
  // payload (onChunk/onResult/onTransition).
  const onTrace = createTraceDispatch({
    onTrace: (payload) => {
      options.onTrace?.({
        schemaVersion: AGENT_TRACE_SCHEMA_VERSION,
        runId,
        seq: ++traceSeq,
        timestamp: new Date().toISOString(),
        machineId,
        machineVersion,
        ...payload,
      } as AgentTraceEvent<TMachine>);
    },
    onChunk: options.onChunk,
    onResult: options.onResult,
    onTransition: options.onTransition as TraceSinks["onTransition"],
  }) as (event: AgentTraceEventPayload<TMachine>) => void;

  const consumeModelCall = () => {
    if (budgetExceeded) {
      throw new AgentMaxModelCallsExceededError(maxModelCalls);
    }
    // Count only calls the budget actually admits, so `usage.modelCalls`
    // reports calls MADE (the rejected attempt never reaches an executor).
    if (modelCallCount + 1 > maxModelCalls) {
      budgetExceeded = true;
      throw new AgentMaxModelCallsExceededError(maxModelCalls);
    }
    modelCallCount += 1;
  };

  // ─── The replayable event log ───
  //
  // `logEntries` is this run's complete log segment: the resumed prefix (if
  // any) plus every event the loop applied, appended in delivery order. It is
  // the value returned as `result.events`, and the value `options.onEvent`
  // streams entry by entry.
  const logEntries: AgentLogEntry[] = [];

  // ─── Write-ahead journaling (`options.store`) ───
  //
  // Every appended entry is queued onto ONE chain, so writes reach the store in
  // log order and each carries its own index as `expectedIndex`. The chain is
  // awaited at two points only: before a model call (`awaitJournal`, the
  // barrier the executors call) and at finish. Pure transitions never wait.
  // The first rejection wins, stops the run (`cause: 'journal'`) and blocks
  // every later write and call.
  const store = options.store;
  const threadId = options.threadId;
  if (store !== undefined && (threadId === undefined || threadId === "")) {
    throw new AgentError(
      "missing-thread-id",
      "createAgentRuntime: `threadId` is required when `store` is given — it names the log thread to read and append to.",
    );
  }
  let journalChain: Promise<void> = Promise.resolve();
  let journalPending = 0;
  let journalError: unknown;

  const journalEntry = (entry: AgentLogEntry): void => {
    if (store === undefined) {
      return;
    }
    journalPending++;
    journalChain = journalChain
      .then(async () => {
        if (journalError !== undefined) {
          return;
        }
        await store.append({
          threadId: threadId!,
          expectedIndex: entry.index,
          entries: [entry],
        });
      })
      .catch((error: unknown) => {
        journalError ??= error;
        stopRun({ cause: "journal", error });
      })
      .finally(() => {
        journalPending--;
      });
  };

  /**
   * Every journal write ISSUED SO FAR, including the stragglers appended after
   * the run settled. Re-reads the chain tail until it stops moving, so a write
   * queued while an earlier one was in flight is covered too. Never rejects: a
   * failed write already settled the run with `cause: 'journal'`.
   */
  const drainJournal = async (): Promise<void> => {
    if (store === undefined) {
      return;
    }
    let tail = journalChain;
    for (;;) {
      await tail;
      if (journalPending === 0 && journalChain === tail) {
        return;
      }
      tail = journalChain;
    }
  };

  /** The barrier: settle the pending chain, then surface any failure. */
  const awaitJournal = async (): Promise<void> => {
    if (store === undefined) {
      return;
    }
    while (journalPending > 0) {
      await journalChain;
    }
    if (journalError !== undefined) {
      throw journalError;
    }
  };

  // Where THIS run's own entries begin — the fold boundary for `runUsage`.
  let resumedLogLength = 0;
  // The lineage id pinned in the log's init entry metadata; also the prefix of
  // every `callKey`.
  let logExecutionId: string | undefined;
  const verificationEnabled = options.verification !== false;
  // The most recent ROOT snapshot the loop committed: what decisions and usage
  // delivery read, what verification hashes stamp, and what `finish` reports.
  let current: AnyMachineSnapshot | undefined;
  // The machine the log is folded against: the authored machine with
  // `options.actors` merged in, so every invoke src resolves. NOT the
  // executor-bound machine — the log must fold the same way for a caller who
  // calls `replay(machine, events)` with no host executors at all.
  let logMachine: AnyStateMachine = machine;

  // Cleared when this run cannot produce a self-contained log at all — a
  // snapshot that is not JSON-safe, or a machine whose init entry cannot be
  // built (see `appendInitEntry`). Journaling a suffix with no `@agent.init`
  // entry would produce a log `replay` rejects, so nothing is journaled.
  let loggingEnabled = true;

  const appendLogEntry = (
    event: EventObject,
    snapshot?: AnyMachineSnapshot | AgentPersistedSnapshot,
  ): AgentLogEntry | undefined => {
    if (!loggingEnabled) {
      return undefined;
    }
    const entry = createReplayEntry(logMachine, logEntries, event, {
      machineVersion,
      verification: verificationEnabled,
      // With no snapshot, `createReplayEntry` re-folds the whole prefix to get
      // the hash. Every applied transition has one to hand, so that fallback
      // is reserved for the rare out-of-band append (see `usageEntrySnapshot`).
      ...(verificationEnabled && snapshot !== undefined ? { snapshot } : {}),
    });
    logEntries.push(entry);
    journalEntry(entry);
    options.onEvent?.(entry);
    return entry;
  };

  // The snapshot an `@agent.usage` entry that was NOT delivered folds to.
  // Replay feeds every journaled entry through `transition`, so the recorded
  // hash must be the POST-transition state. When the live configuration
  // declares no `@agent.usage` transition (the common case) that transition is
  // a no-op and the current snapshot is exactly right. Otherwise the event was
  // withheld from a machine that would have reacted (a guard, or a straggler
  // after finish), so the current snapshot is NOT what replay produces — fall
  // back to `createReplayEntry`'s own fold, which is correct by construction.
  const usageEntrySnapshot = (): AnyMachineSnapshot | undefined => {
    if (current && (current.status !== "active" || !declaresUsageTransition(current))) {
      return current;
    }
    return undefined;
  };

  // Reserved `@agent.usage` delivery — the seam that puts a settled call's
  // tokens in reach of the machine's own context and guards (see
  // AGENT_USAGE_EVENT_TYPE). Opt-in BY CONSTRUCTION: queued for the machine
  // only when the current root snapshot DECLARES a transition that receives
  // the reserved type. A machine that declares none gets no extra transition,
  // no `machine.transition` trace, and the entry is journaled out of band.
  //
  // Root only: usage from a request inside an INVOKED CHILD machine is
  // reported to the root too, attributed by the event's `id`/`src`/`model`.
  //
  // A call that settles AFTER the run has finished is a straggler: its tokens
  // still fold into the log, but the event is DROPPED rather than delivered,
  // so a late arrival can never affect an already-returned result. Dropped
  // stragglers are visible on `onTrace` as `usage.dropped`.
  const recordUsage = (usage: AgentCallUsage, source: AgentUsageEventSource = {}) => {
    const event: AgentUsageEvent = { type: AGENT_USAGE_EVENT_TYPE, ...source, usage };
    let delivered = false;
    deliverUsageEvent(
      event,
      () => rootFacade(() => (delivered = true)),
      (dropped) => {
        if (!finished) {
          return false;
        }
        onTrace({ type: "usage.dropped", event: dropped, reason: "settled" });
        return true;
      },
    );
    if (!delivered) {
      appendLogEntry(event, usageEntrySnapshot());
    }
  };
  // Run-scoped, and a pure projection of the log: fold the `@agent.usage`
  // entries THIS run appended (everything past the resumed prefix). The prior
  // leg's entries are still in `result.events`, so a caller that wants the
  // cumulative total folds the whole log with `getUsageFromEvents`.
  const runUsage = (): AgentUsage => ({
    ...getUsageFromEvents(logEntries.slice(resumedLogLength)),
    modelCalls: modelCallCount,
  });

  // Dev-only: on idle finish, warn once if the snapshot's context holds values
  // that won't round-trip through JSON persistence. Skipped in production and
  // after the first warning. Guarded so a getter/exotic context can't throw.
  const warnNonSerializableContext = (snapshot: AnyMachineSnapshot) => {
    if (warnedNonSerializable || process.env.NODE_ENV === "production") {
      return;
    }
    let offending: string[] = [];
    try {
      offending = findNonSerializableContextPaths((snapshot as { context?: unknown }).context);
    } catch {
      return;
    }
    if (offending.length === 0) {
      return;
    }
    warnedNonSerializable = true;
    console.warn(
      `createAgentRuntime: context holds value(s) that will not survive snapshot ` +
        `persist/resume (JSON round-trip): ${offending.join(", ")}. Persist only ` +
        `JSON-serializable context, or convert these before the run settles.`,
    );
  };

  // Bind sources: `machine.provide({ actors: options.actors })` first, then
  // walk the EFFECTIVE (post-provide) sources (chained provides merge).
  const provided = machine.provide({
    actors: options.actors as never,
  }) as TMachine;

  logMachine = provided;

  const effectiveSources = provided.sources.actors as Record<string, AnyActorLogic>;

  const executors = { ...options.executors };

  assertBindable(provided, effectiveSources, executors);

  // The root, as the bind wrappers see it: its current snapshot, and a `send`
  // that queues onto the mailbox. The loop has no live root actor — every
  // transition is pure — so this facade is the one place "the root" lives.
  const rootFacade = (onSend?: () => void): AnyActorRef =>
    ({
      getSnapshot: () => current,
      send: (event: EventObject) => {
        onSend?.();
        enqueue(event);
      },
    }) as unknown as AnyActorRef;
  const actorHolder: { actorRef: AnyActorRef | undefined } = { actorRef: rootFacade() };
  const runCtx: RunAgentBindContext = {
    generateText: executors.generateText,
    streamText: executors.streamText,
    decide: executors.decide,
    emitTrace: onTrace as TraceDispatch,
    consumeModelCall,
    recordUsage,
    actorHolder,
    awaitJournal,
    runId,
    schemas: getRegisteredAgentExecutionOptions(machine).schemas,
  };

  const wrappedSources: Record<string, AnyActorLogic> = {};

  // Wrap every effective TextLogic/DecisionLogic (and the agent.* builtins)
  // with a host-backed executor. Invoked child machines are recursively
  // rebound so their requests inherit the same executors at any depth (see
  // rebindChildMachine). Every other source (plain actors, non-agent logic)
  // passes through untouched.
  for (const [key, logic] of Object.entries(effectiveSources)) {
    if (isDecisionLogic(logic)) {
      wrappedSources[key] = bindDecisionLogic(logic, runCtx);
      continue;
    }

    if (isTextLogic(logic)) {
      // A text logic that already carries its own executor (`.withExecutor`)
      // runs itself — leave it untouched.
      if (!executorBoundLogics.has(logic as object)) {
        wrappedSources[key] = bindTextLogic(logic, runCtx);
      }
      continue;
    }

    if (isStateMachineLogic(logic)) {
      const rebound = rebindChildMachine(logic, runCtx, new Set<AnyStateMachine>([machine]));
      if (rebound !== logic) {
        wrappedSources[key] = rebound;
      }
      continue;
    }
  }

  const boundMachine = provided.provide({
    actors: wrappedSources as never,
  }) as TMachine;

  // ─── The mailbox ───
  //
  // One queue for everything that can move the machine: child completions and
  // failures, child messages, root timers, the reserved usage event. Filled as
  // things happen (never batched), drained one event per transition.
  const mailbox: EventObject[] = [];
  let wake: ((event: EventObject | typeof QUIESCENT) => void) | undefined;
  // Events the loop handed out, as opposed to events the host brought in
  // itself: only the host's own event can be reported as `ignored`.
  const fromMailbox = new WeakSet<object>();
  let stopReason: StopReason | undefined;
  let started = false;
  let finished = false;
  let ignoredEvent: EventObject | undefined;

  const enqueue = (event: EventObject): void => {
    if (finished) {
      return;
    }
    fromMailbox.add(event);
    const waiting = wake;
    if (waiting) {
      wake = undefined;
      waiting(event);
    } else {
      mailbox.push(event);
    }
  };

  // ─── Timers ───
  const inProcessTimers = options.timers === undefined || options.timers === "in-process";
  const timerHandles = new Map<string, ReturnType<typeof setTimeout>>();
  const timerKey = (source: AnyActorRef | undefined, id: string) =>
    `${(source as { address?: string } | undefined)?.address ?? "(root)"}::${id}`;
  // Arms one timer. A root timer fires into the mailbox; a child's timer is
  // delivered to that child, which resolves it from its own snapshot.
  const armTimer = (
    source: AnyActorRef | undefined,
    isRoot: boolean,
    id: string,
    delay: number,
  ) => {
    if (isRoot && !inProcessTimers) {
      (options.timers as Exclude<AgentTimerScheduler, "in-process">).schedule({ id, delay });
      return;
    }
    const key = timerKey(isRoot ? undefined : source, id);
    clearTimeout(timerHandles.get(key));
    timerHandles.set(
      key,
      setTimeout(() => {
        timerHandles.delete(key);
        const timerEvent = { type: "xstate.timer", id } as EventObject;
        if (isRoot) {
          enqueue(timerEvent);
        } else {
          source?.send(timerEvent as never);
        }
        recheck();
      }, delay),
    );
  };

  // ─── Quiescence ───
  //
  // Work is in flight while any child is still running — a request, a plain
  // async actor, a child machine whose own children are running — or an
  // in-process timer is armed. A child machine at rest is waiting for events,
  // not doing work, so it does not count.
  const childrenBusy = (snapshot: AnyMachineSnapshot | undefined): boolean =>
    Object.values((snapshot?.children ?? {}) as Record<string, AnyActorRef | undefined>).some(
      (child) => {
        const childSnapshot = child?.getSnapshot?.() as AnyMachineSnapshot | undefined;
        if (childSnapshot?.status !== "active") {
          return false;
        }
        return isMachineSnapshot(childSnapshot) ? childrenBusy(childSnapshot) : true;
      },
    );
  const workInFlight = (): boolean =>
    childrenBusy(current) || (inProcessTimers && timerHandles.size > 0);

  // Re-checked whenever anything the run started changes, so the loop stops
  // waiting once the last bit of work settles — even work that never messages
  // the root (a child machine finishing internally). A child's snapshot turns
  // `done` a moment BEFORE its completion is relayed to the mailbox, so a
  // quiet moment is confirmed one macrotask later, after that relay landed.
  let recheckScheduled = false;
  const recheck = (): void => {
    if (wake === undefined || recheckScheduled) {
      return;
    }
    if (stopReason === undefined && workInFlight()) {
      return;
    }
    recheckScheduled = true;
    setTimeout(() => {
      recheckScheduled = false;
      if (wake !== undefined && (stopReason !== undefined || !workInFlight())) {
        const waiting = wake;
        wake = undefined;
        waiting(QUIESCENT);
      }
    }, 0);
  };

  const stopChildren = (snapshot: AnyMachineSnapshot | undefined): void => {
    for (const child of Object.values(
      (snapshot?.children ?? {}) as Record<string, AnyActorRef | undefined>,
    )) {
      // The public runtime helper stops children and aborts their signals.
      try {
        if (child) stopActor(child as AnyActor);
      } catch {
        // Already stopped.
      }
    }
    for (const handle of timerHandles.values()) {
      clearTimeout(handle);
    }
    timerHandles.clear();
  };

  // Stops the loop early: a cancel, a journal failure, an effect that threw.
  // In-flight children are stopped (which aborts their requests' signals) and
  // a parked `nextEvent` returns.
  let persistedAtStop: Snapshot<unknown> | undefined;
  const stopRun = (reason: StopReason): void => {
    if (finished || stopReason !== undefined) {
      return;
    }
    stopReason = reason;
    // Persisted before the children stop, so a resume restarts the work
    // this stop cut off instead of finding it stopped.
    try {
      persistedAtStop = current && boundMachine.getPersistedSnapshot(current as never);
    } catch {
      // `finish` persists (and reports the failure) itself.
    }
    stopChildren(current);
    recheck();
  };

  const onAbort = () =>
    stopRun({ cause: "aborted", error: options.signal?.reason ?? new Error("Aborted") });

  const emitFromRoot = (event: EventObject): void => {
    onTrace({ type: "emit", event: event as EmittedFrom<TMachine> });
    const on = (options.on ?? {}) as Record<string, ((event: EventObject) => void) | undefined>;
    on[event.type]?.(event);
    if (event.type !== "*") {
      on["*"]?.(event);
    }
  };

  const inspect =
    options.inspect === undefined
      ? undefined
      : (event: InspectionEvent) => {
          if (typeof options.inspect === "function") {
            options.inspect(event);
          } else {
            options.inspect?.next?.(event);
          }
        };

  let execution!: DurableExecution<TMachine>;
  const durableAdapter = {
    startActor: (actor: AnyActorRef) => {
      // Every actor the run starts is watched, so quiescence is noticed the
      // moment it happens. The error handler also keeps XState from
      // reporting a child error the machine already handles as unhandled.
      actor.subscribe({ next: recheck, complete: recheck, error: recheck });
      (actor as unknown as { start(): void }).start();
    },
    enqueueRootEvent: (_source: unknown, event: EventObject) => enqueue(event),
    executeAction: (
      action: { exec: (runtime: unknown) => unknown },
      _metadata: unknown,
      runtime: unknown,
    ) => action.exec(runtime),
    waitForEvent: () => {
      const queued = mailbox.shift();
      if (queued !== undefined) {
        return queued;
      }
      if (stopReason !== undefined || finished || !workInFlight()) {
        return QUIESCENT as unknown as EventObject;
      }
      return new Promise<EventObject>((resolve) => {
        wake = resolve as (event: EventObject | typeof QUIESCENT) => void;
      });
    },
    emitEvent: (
      source: AnyActorRef & { _emit?: (event: EventObject) => void },
      event: EventObject,
    ) => {
      if ((source as { address?: string }).address === execution.rootAddress) {
        emitFromRoot(event);
      } else {
        source._emit?.(event);
      }
    },
    scheduleTimer: (source: AnyActorRef, id: string, delay: number) => {
      // A restored checkpoint's timers arrive here with what is left of
      // their delay: XState keeps their deadlines across persistence.
      armTimer(source, (source as AnyActor).address === execution.rootAddress, id, delay);
    },
    cancelTimer: (source: AnyActorRef, id: string) => {
      const isRoot = (source as { address?: string }).address === execution.rootAddress;
      if (isRoot && !inProcessTimers) {
        (options.timers as Exclude<AgentTimerScheduler, "in-process">).cancel(id);
        return;
      }
      const key = timerKey(isRoot ? undefined : source, id);
      clearTimeout(timerHandles.get(key));
      timerHandles.delete(key);
    },
    cancelAllTimers: (source: AnyActorRef) => {
      const isRoot = (source as { address?: string }).address === execution.rootAddress;
      const prefix = timerKey(isRoot ? undefined : source, "");
      for (const [key, handle] of timerHandles) {
        if (key.startsWith(prefix)) {
          clearTimeout(handle);
          timerHandles.delete(key);
        }
      }
    },
  } as unknown as Parameters<typeof createDurable<TMachine>>[1];
  execution = createDurable(boundMachine, durableAdapter, inspect ? { inspect } : undefined);

  // The run-level error cause ladder.
  const runErrorCause = (error: unknown): AgentRunErrorCause =>
    budgetExceeded
      ? "max-model-calls"
      : wrapsDecisionExhausted(error)
        ? "decision-exhausted"
        : "machine";

  const commit = (snapshot: AnyMachineSnapshot, event: EventObject): void => {
    current = snapshot;
    onTrace({
      type: "machine.transition",
      snapshot: snapshot as SnapshotFrom<TMachine>,
      event: event as EventFromLogic<TMachine>,
    });
  };

  /** True for a child completion/failure whose child is no longer running under the current state. */
  const isStaleChildEvent = (event: EventObject): boolean => {
    if (
      !event.type.startsWith("xstate.done.actor") &&
      !event.type.startsWith("xstate.error.actor")
    ) {
      return false;
    }
    const { sessionId, actorId } = event as { sessionId?: string; actorId?: string };
    return !Object.values(
      (current?.children ?? {}) as Record<
        string,
        (AnyActorRef & { id?: string; sessionId?: string }) | undefined
      >,
    ).some((child) =>
      sessionId !== undefined ? child?.sessionId === sessionId : child?.id === actorId,
    );
  };

  const runtime: AgentRuntime<TMachine> = {
    async start(init = {}) {
      if (started) {
        throw new AgentError("runtime-started", "createAgentRuntime: `start` was already called.");
      }
      started = true;

      // ─── Resolve the log to resume from ───
      let resumeEvents = init.events;
      if (store !== undefined) {
        const storedThread = await store.read(threadId!);
        if (resumeEvents !== undefined) {
          // An explicit log wins as the resume, but it must BE the thread's
          // log: appending onto a store that has moved on — or onto a
          // same-length log that says something else — would interleave two
          // lineages.
          if (storedThread.length !== resumeEvents.length) {
            throw new AgentEventLogConflictError(
              threadId!,
              resumeEvents.length,
              storedThread.length,
            );
          }
          assertThreadMatchesEvents(threadId!, storedThread, resumeEvents);
        } else if (storedThread.length > 0) {
          resumeEvents = storedThread;
        }
      }

      // Validated once, then used everywhere `input` would have been: the
      // start, the replayable init entry, and the `run.start` trace all see
      // the same post-defaults value, so a replay reproduces this run exactly.
      const resolvedInput = resolveMachineInput(machine, init.input);
      let effectiveSnapshot: Snapshot<unknown> | undefined = init.snapshot;
      let seedInitEntry: (() => void) | undefined;

      // The persisted form of `init.snapshot` AFTER XState has restored it
      // (which is where `createMachine({ migrate })` runs), so an init entry
      // records the snapshot the machine will actually resume from.
      const restoredPersistedSnapshot = (): AgentPersistedSnapshot | undefined => {
        try {
          const restored = (
            logMachine as unknown as {
              restoreSnapshot(persisted: AgentPersistedSnapshot): AnyMachineSnapshot;
            }
          ).restoreSnapshot(init.snapshot as AgentPersistedSnapshot);
          return logMachine.getPersistedSnapshot(restored) as AgentPersistedSnapshot;
        } catch {
          return undefined;
        }
      };

      /**
       * Appends the log's reserved first entry, trying each candidate `init`
       * in turn and, for each, an unverified entry if the hash cannot be
       * computed. A machine or snapshot that defeats every attempt leaves the
       * run WITHOUT a log rather than failing it.
       */
      const appendInitEntry = (
        candidates: readonly AgentLogInit[],
        metadata: Record<string, AgentLogJsonValue>,
      ): void => {
        for (const candidate of candidates) {
          for (const verification of verificationEnabled ? [true, false] : [false]) {
            try {
              const entry = initEntry(logMachine, candidate, {
                machineVersion,
                verification,
                metadata,
              });
              logEntries.push(entry);
              journalEntry(entry);
              options.onEvent?.(entry);
              return;
            } catch {
              // Try the next (less exact) form.
            }
          }
        }
        loggingEnabled = false;
      };

      /** Init forms for a snapshot resume, most faithful first. */
      const snapshotInitCandidates = (): AgentLogInit[] => {
        const restored = restoredPersistedSnapshot();
        return [
          ...(restored !== undefined ? [{ snapshot: restored } as AgentLogInit] : []),
          { snapshot: init.snapshot as AgentPersistedSnapshot } as AgentLogInit,
        ];
      };

      // ─── Resume precedence: the log is truth, the snapshot is a cache ───
      //
      // 1. `events` at THIS machine version — continue that log. A `snapshot`
      //    stamped at the log's tail (same lineage, same length, matching
      //    hash) is trusted as-is; anything else replays the log and, when the
      //    snapshot claims a position in it, hash-checks the snapshot there.
      // 2. `events` at ANOTHER machine version — a `snapshot` is required
      //    (XState's `migrate` applies on restore) and the run opens a NEW log
      //    segment whose init entry carries the post-migration snapshot and
      //    `migratedFrom`.
      // 3. `snapshot` only — restore it and start a self-contained log from it.
      // 4. Neither — a fresh start, logged from `input`.
      if (resumeEvents !== undefined && resumeEvents.length > 0) {
        validateReplayEntries(resumeEvents);
        const tail = resumeEvents[resumeEvents.length - 1]!;
        const inheritedExecutionId = getLogExecutionId(resumeEvents);
        // A log written by a DIFFERENT machine is never a resume for this one.
        if (resumeEvents[0]!.machineId !== machineId) {
          throw new AgentMachineVersionMismatchError(
            tail.id,
            tail.index,
            { machineId, machineVersion },
            { machineId: resumeEvents[0]!.machineId, machineVersion: tail.machineVersion },
          );
        }
        const sameMachine = tail.machineVersion === machineVersion;

        if (sameMachine) {
          logEntries.push(...resumeEvents);
          resumedLogLength = logEntries.length;
          logExecutionId = inheritedExecutionId;

          // Lineage, not length: the fast path also requires the log's
          // `executionId` and the tail entry's recorded hash to agree. No
          // hash, no fast path — the log is the truth.
          const cachedMeta = readAgentMeta(init.snapshot);
          const tailStateHash = tail.verification?.stateHash;
          const trustedCache =
            init.snapshot !== undefined &&
            inheritedExecutionId !== undefined &&
            cachedMeta?.logId === inheritedExecutionId &&
            cachedMeta.logIndex === resumeEvents.length &&
            tailStateHash !== undefined &&
            hashResumeSnapshot(init.snapshot) === tailStateHash;

          if (!trustedCache) {
            const cachedIndex = cachedMeta?.logIndex;
            if (
              init.snapshot !== undefined &&
              typeof cachedIndex === "number" &&
              cachedIndex >= 1 &&
              cachedIndex <= resumeEvents.length &&
              // Only a verified log can call a snapshot divergent.
              resumeEvents[cachedIndex - 1]!.verification?.stateHash !== undefined
            ) {
              const atCache = replay(logMachine, resumeEvents.slice(0, cachedIndex), {
                machineVersion,
                verify: false,
              });
              const expected = getSnapshotStateHash(atCache.persistedSnapshot);
              const actual = hashResumeSnapshot(init.snapshot);
              if (expected !== actual) {
                throw new AgentSnapshotDivergedError(expected, actual, cachedIndex);
              }
            }
            effectiveSnapshot = replay(logMachine, resumeEvents, {
              machineVersion,
              verify: true,
            }).persistedSnapshot as Snapshot<unknown>;
          }
        } else {
          // Version bridge. Without a snapshot there is nothing to migrate FROM.
          if (init.snapshot === undefined) {
            throw new AgentMachineVersionMismatchError(
              tail.id,
              tail.index,
              { machineId, machineVersion },
              { machineId: tail.machineId, machineVersion: tail.machineVersion },
            );
          }
          // The snapshot must BE the cache of THIS log's tail under the old
          // version: an older or foreign snapshot would silently roll the
          // thread back to state the log has already moved past.
          const bridgeMeta = readAgentMeta(init.snapshot);
          if (inheritedExecutionId === undefined || bridgeMeta?.logId !== inheritedExecutionId) {
            throw new AgentMachineVersionMismatchError(
              tail.id,
              tail.index,
              { machineId, machineVersion },
              { machineId: tail.machineId, machineVersion: tail.machineVersion },
            );
          }
          const bridgeTailHash = tail.verification?.stateHash;
          // Hashed BEFORE any migration.
          const bridgeSnapshotHash = hashResumeSnapshot(init.snapshot);
          if (bridgeMeta.logIndex !== resumeEvents.length) {
            throw new AgentSnapshotDivergedError(
              bridgeTailHash ?? "(unrecorded)",
              bridgeSnapshotHash,
              resumeEvents.length,
            );
          }
          if (bridgeTailHash !== undefined && bridgeSnapshotHash !== bridgeTailHash) {
            throw new AgentSnapshotDivergedError(
              bridgeTailHash,
              bridgeSnapshotHash,
              resumeEvents.length,
            );
          }
          logExecutionId = inheritedExecutionId;
          const migratedFrom: Record<string, AgentLogJsonValue> = {
            machineVersion: tail.machineVersion,
            logIndex: resumeEvents.length,
          };
          seedInitEntry = () =>
            appendInitEntry(snapshotInitCandidates(), {
              ...(logExecutionId !== undefined ? { executionId: logExecutionId } : {}),
              migratedFrom,
            });
        }
      } else if (init.snapshot !== undefined) {
        logExecutionId = crypto.randomUUID();
        seedInitEntry = () =>
          appendInitEntry(snapshotInitCandidates(), { executionId: logExecutionId! });
      } else {
        logExecutionId = crypto.randomUUID();
        seedInitEntry = () =>
          appendInitEntry([resolvedInput !== undefined ? { input: resolvedInput } : {}], {
            executionId: logExecutionId!,
          });
      }

      // ─── Per-call idempotency keys (`info.callKey`) ───
      // `${executionId}:${siteId}#${n}`: the log lineage plus the occurrence
      // of this call at this invoke site, counted over the RESUMED prefix and
      // advanced by the calls this run has already started at that site. A
      // crash recovery whose log holds one completion re-executes the
      // in-flight call as `#2`, exactly the id a replay derives for it.
      const resumedHistory: readonly AgentLogEntry[] = [...logEntries];
      const siteCallCounts = new Map<string, number>();
      const mintedCallKeys = new WeakMap<object, string>();
      runCtx.callKey = (siteId: string, self?: object) => {
        if (logExecutionId === undefined) {
          return undefined;
        }
        const memoized = self === undefined ? undefined : mintedCallKeys.get(self);
        if (memoized !== undefined) {
          return memoized;
        }
        const startedHere = siteCallCounts.get(siteId) ?? 0;
        siteCallCounts.set(siteId, startedHere + 1);
        const key = `${logExecutionId}:${siteId}#${agentCallOccurrence(resumedHistory, siteId) + startedHere}`;
        if (self !== undefined) {
          mintedCallKeys.set(self, key);
        }
        return key;
      };

      seedInitEntry?.();

      const resumeEvent = (init as AgentRunInit<TMachine>).event as
        | EventFromLogic<TMachine>
        | undefined;
      onTrace({
        type: "run.start",
        ...(resolvedInput !== undefined ? { input: resolvedInput as InputFrom<TMachine> } : {}),
        ...(effectiveSnapshot !== undefined ? { snapshot: effectiveSnapshot } : {}),
        ...(resumeEvent !== undefined ? { event: resumeEvent } : {}),
      });

      if (options.signal) {
        if (options.signal.aborted) {
          stopReason = {
            cause: "aborted",
            error: options.signal.reason ?? new Error("Aborted"),
          };
        } else {
          options.signal.addEventListener("abort", onAbort);
        }
      }

      let snapshot: AnyMachineSnapshot;
      let effects: AgentEffects = [];
      const initEvent = {
        type: "@xstate.init",
        ...(resolvedInput !== undefined ? { input: resolvedInput } : {}),
      } as EventObject;
      if (effectiveSnapshot === undefined) {
        [snapshot, effects] = execution.initialTransition(resolvedInput as never) as [
          AnyMachineSnapshot,
          AgentEffects,
        ];
      } else {
        try {
          // Restores the checkpoint without sending the machine an event; its
          // effects restart the children and timers that were in flight.
          [snapshot, effects] = execution.restore(effectiveSnapshot) as [
            AnyMachineSnapshot,
            AgentEffects,
          ];
        } catch (error) {
          // A snapshot this machine cannot restore fails the run on its own
          // terms rather than throwing out of the host.
          // The initial state stands in as the result's snapshot; its effects
          // are discarded, so nothing runs.
          try {
            current = execution.initialTransition(resolvedInput as never)[0] as AnyMachineSnapshot;
          } catch {
            current = {
              status: "error",
              error,
              context: undefined,
            } as unknown as AnyMachineSnapshot;
          }
          stopReason ??= { cause: "machine", error };
          return [current as SnapshotFrom<TMachine>, []];
        }
        current = snapshot;
      }
      commit(snapshot, initEvent);
      return [snapshot as SnapshotFrom<TMachine>, effects];
    },

    transition(state, event) {
      if (finished) {
        throw new AgentError(
          "runtime-finished",
          "createAgentRuntime: the run has finished; start a new runtime to continue.",
        );
      }
      // A stopped run (cancelled, or its journal failed) takes no more events.
      if (stopReason !== undefined) {
        return [state, []];
      }
      const [next, effects] = execution.transition(state, event as EventFromLogic<TMachine>) as [
        AnyMachineSnapshot,
        AgentEffects,
      ];
      // The host's own event (not one the mailbox handed out) was ignored when
      // the state has no transition for it: nothing changed and nothing is to
      // be done. Reported as `result.ignored`; still journaled.
      if (
        !fromMailbox.has(event as object) &&
        (next as unknown) === (state as unknown) &&
        effects.length === 0
      ) {
        ignoredEvent = event as EventObject;
      }
      appendLogEntry(event as EventObject, next);
      commit(next, event as EventObject);
      return [next as SnapshotFrom<TMachine>, effects];
    },

    async execute(effects) {
      if (stopReason !== undefined || finished || effects.length === 0) {
        return;
      }
      try {
        await execution.executeEffects(effects as never);
      } catch (error) {
        stopRun({ cause: "machine", error });
      }
      recheck();
    },

    async nextEvent() {
      for (;;) {
        if (finished || stopReason !== undefined || current?.status !== "active") {
          return undefined;
        }
        const event = (await execution.waitForEvent()) as EventObject | typeof QUIESCENT;
        if ((event as unknown) === QUIESCENT || stopReason !== undefined) {
          return undefined;
        }
        // A completion from an actor the machine already stopped is ignored,
        // as XState itself ignores it: no transition, no log entry. (A
        // decision sends its chosen event and then completes; the chosen
        // event leaves the state and stops the decision, so its completion
        // arrives with nobody left to receive it.)
        if (isStaleChildEvent(event as EventObject)) {
          continue;
        }
        return event as EventFromLogic<TMachine>;
      }
    },

    async finish() {
      if (finished) {
        throw new AgentError(
          "runtime-finished",
          "createAgentRuntime: `finish` was already called.",
        );
      }
      const snapshot = current as AnyMachineSnapshot;
      let outcome: AgentRunOutcome<TMachine>;
      if (stopReason !== undefined) {
        outcome = {
          status: "error",
          cause:
            stopReason.cause === "machine" ? runErrorCause(stopReason.error) : stopReason.cause,
          error: stopReason.error,
          snapshot: snapshot as SnapshotFrom<TMachine>,
        };
      } else if (snapshot.status === "done") {
        outcome = {
          status: "done",
          output: snapshot.output as OutputFrom<TMachine>,
          snapshot: snapshot as SnapshotFrom<TMachine>,
        };
      } else if (snapshot.status === "error") {
        // Reaching an error state means no `onError` transition handled the
        // failure, so a decision exhaustion surfacing here is genuinely unhandled.
        outcome = {
          status: "error",
          cause: runErrorCause(snapshot.error),
          error: snapshot.error,
          snapshot: snapshot as SnapshotFrom<TMachine>,
        };
      } else if (snapshot.status === "stopped") {
        outcome = {
          status: "error",
          cause: "stopped",
          error: new Error("Actor stopped externally."),
          snapshot: snapshot as SnapshotFrom<TMachine>,
        };
      } else {
        // Idle is the moment persistence matters: the caller resumes from
        // this snapshot by JSON round-trip.
        warnNonSerializableContext(snapshot);
        outcome = { status: "idle", snapshot: snapshot as SnapshotFrom<TMachine> };
      }

      // Persisted BEFORE anything is stopped (for an early stop, by
      // `stopRun`): a stopped child would persist as stopped, and the
      // snapshot must resume with its children running.
      let persistedSnapshot: Snapshot<unknown> | undefined = persistedAtStop;
      let persistenceError: unknown;
      if (outcome.status !== "done" && persistedSnapshot === undefined) {
        try {
          persistedSnapshot = boundMachine.getPersistedSnapshot(
            snapshot as never,
          ) as Snapshot<unknown>;
        } catch (error) {
          persistenceError = error;
        }
      }
      // The log position this snapshot caches, frozen here: a straggler
      // appended afterwards makes the cache stale, and the stamp says so.
      const logIndexAtSettle = logEntries.length;
      const persist = () => {
        if (persistenceError !== undefined) {
          throw persistenceError;
        }
        persistedSnapshot ??= boundMachine.getPersistedSnapshot(
          snapshot as never,
        ) as Snapshot<unknown>;
        // Stamped on the PERSISTED object only — a plain enumerable field, so
        // it survives a JSON round-trip and is read back by the next resume.
        (persistedSnapshot as { agentMeta?: AgentRunMeta }).agentMeta = {
          machineId,
          version: machineVersion,
          ...(logExecutionId !== undefined ? { logId: logExecutionId } : {}),
          logIndex: logIndexAtSettle,
        };
        return persistedSnapshot;
      };

      finished = true;
      // Every write queued so far: the result waits for these. A straggler
      // entry appended after this point is still written, but not awaited.
      const journalAtSettle = journalChain;
      const result = {
        ...outcome,
        events: [...logEntries],
        persist,
        drain: drainJournal,
        usage: runUsage(),
        ...(ignoredEvent !== undefined ? { ignored: ignoredEvent } : {}),
      } as AgentRunResult<TMachine>;
      onTrace({ type: "run.end", ...outcome } as AgentTraceEventPayload<TMachine>);
      options.signal?.removeEventListener("abort", onAbort);
      stopChildren(snapshot);
      if (wake !== undefined) {
        const waiting = wake;
        wake = undefined;
        waiting(QUIESCENT);
      }
      // The run resolves only once the log it reports is durable. A write
      // that rejected has already stopped the run with `cause: 'journal'`.
      await journalAtSettle;
      return result;
    },
  };

  return runtime;
}

/**
 * The actor handed to an {@link inspectTransitions} handler: an
 * {@link AnyActorRef} widened with the runtime `id`/`src` used to attribute a
 * transition to the root machine or a specific invoked child (xstate's static
 * `ActorRef` type omits them, but they are always present at runtime).
 */
export type InspectedActorRef = AnyActorRef & { id: string; src?: string | AnyActorLogic };

/**
 * Wraps a `(snapshot, actorRef) => void` handler into a function usable as
 * {@link AgentRuntimeOptions.inspect}: it filters the raw inspection stream to
 * `@xstate.transition` events and hands the handler the typed
 * {@link AnyMachineSnapshot} and the {@link InspectedActorRef} that
 * transitioned. Attribute a child actor via `actorRef.id`/`actorRef.src`. Saves
 * the manual `event.type === '@xstate.transition'` filtering and the snapshot/
 * actorRef casts.
 */
export function inspectTransitions(
  handler: (snapshot: AnyMachineSnapshot, actorRef: InspectedActorRef) => void,
): (inspectionEvent: InspectionEvent) => void {
  return (inspectionEvent: InspectionEvent) => {
    if (inspectionEvent.type !== "@xstate.transition") {
      return;
    }
    handler(
      inspectionEvent.snapshot as AnyMachineSnapshot,
      inspectionEvent.actorRef as unknown as InspectedActorRef,
    );
  };
}

/**
 * An xstate `inspect` handler that emits `machine.transition` trace events onto
 * `onTrace`, sharing the SAME versioned envelope and per-root-actor `seq`
 * registry as {@link provideExecutors}' `onTrace`. Pair the two on one actor to
 * get a single ordered trace stream (request + transition events) for the
 * uncontrolled path:
 *
 * ```ts
 * const bound = provideExecutors(machine, executors, { onTrace });
 * const actor = createActor(bound, { inspect: traceTransitions(onTrace) });
 * ```
 *
 * Only ROOT-actor transitions are traced (matching the runtime's
 * `machine.transition`); child-actor transitions are ignored. Attribute the
 * event via its envelope `runId`.
 *
 * By design this path has NO `run.start`/`run.end` events: `createActor` has no
 * run boundary the way `createAgentRuntime` does, so the stream starts at the actor's
 * first transition. It also does NOT emit `emit` trace events: in this xstate
 * build emitted events are delivered through `actor.on(...)`, not the inspection
 * protocol, so they are not observable from an `inspect` handler — subscribe
 * with `actor.on('*', ...)` if you need them.
 */
export function traceTransitions<TMachine extends AnyStateMachine = AnyStateMachine>(
  onTrace: (event: AgentTraceEvent<TMachine>) => void,
): (inspectionEvent: InspectionEvent) => void {
  return (inspectionEvent: InspectionEvent) => {
    if (inspectionEvent.type !== "@xstate.transition") {
      return;
    }
    const actorRef = inspectionEvent.actorRef as unknown as { _parent?: unknown };
    // Root actor only (no parent) — matches the runtime's root-transition filter.
    if (actorRef?._parent) {
      return;
    }
    const root = actorRef as unknown as AnyActorRef;
    onTrace(
      stampRootTrace(root, {
        type: "machine.transition",
        snapshot: inspectionEvent.snapshot as SnapshotFrom<TMachine>,
        event: inspectionEvent.event as EventFromLogic<TMachine>,
      }) as AgentTraceEvent<TMachine>,
    );
  };
}

/**
 * Whether a snapshot is asking the outside world for something: an active
 * snapshot that accepts an external event anywhere in its active hierarchy,
 * or declares interaction metadata on an active state.
 *
 * The runtime does not use this to stop; a run settles when nothing is in
 * flight. Use it once the run is quiescent, to tell a human wait (render
 * `getInteraction(snapshot)`) from a machine that is simply stuck.
 */
export function isAgentIdle(snapshot: AnyMachineSnapshot): boolean {
  if (snapshot.status !== "active") {
    return false;
  }
  const hasInteraction = snapshot.nodes.some((node) => {
    const meta = node.meta;
    return typeof meta === "object" && meta !== null && "interaction" in meta;
  });
  return hasInteraction || getAcceptedEvents(snapshot).length > 0;
}
