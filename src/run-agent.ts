import {
  createActor,
  createAsyncLogic,
  getNextTransitions,
  isMachineSnapshot,
  type AnyActorLogic,
  type AnyActorRef,
  type AnyMachineSnapshot,
  type AnyStateMachine,
  type EmittedFrom,
  type EventObject,
  type EventFromLogic,
  type InputFrom,
  type InspectionEvent,
  type OutputFrom,
  type Snapshot,
  type SnapshotFrom,
} from "xstate";
import type { AgentMessage, AgentTools, ChosenEvent } from "./types.js";
import { AgentError } from "./errors.js";
import {
  findNonSerializableContextPaths,
  getAgentMessages,
  getMachineStructuralHash,
} from "./utils.js";
import {
  runStateRequestPass,
  type AgentStateRequest,
  type StateRequestPassDeps,
} from "./internal/state-request-pass.js";

export type { AgentStateRequest } from "./internal/state-request-pass.js";
import { getAcceptedEvents, sanitizeEventToolName, type AgentSchemas } from "./events.js";
import {
  AGENT_USAGE_TOKEN_FIELDS,
  extractCallUsage,
  isTextLogic,
  normalizeGeneratorResult,
  USER_INPUT_ACTOR,
  type AgentCallUsage,
  type AgentUsage,
  type AgentExecutorTextRequest,
  type AgentRequestExecutor,
  type AgentRequestExecutors,
  type AgentTextRequest,
  type AgentUserInput,
  type TextLogic,
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
  getMachineSuspensionPredicate,
  getRegisteredAgentExecutionOptions,
  isUnboundPlaceholder,
} from "./internal/registry.js";
import {
  createReplayEntry,
  initEntry,
  replay,
  AGENT_INIT_EVENT_TYPE,
  AGENT_USAGE_EVENT_TYPE,
  AgentReplayMachineMismatchError,
  type AgentUsageEvent,
} from "./effects.js";
import { assertAgentLogEntry, type AgentLogEntry, type JsonValue } from "./event-log-store.js";

// ─── runAgent (createActor wrapper) ───
//
// See .scratch/p0-design.md §3. Unlike the step helpers above (a pure
// transition-at-a-time path for durable hosts), `runAgent` owns a live
// `createActor` actor: it binds host executors directly onto the machine's
// agent actor sources, runs the actor to completion or idle, and reports a
// `done | idle | error` result. There is no continuation callback — idle
// always settles and the caller resumes by snapshot (§3.4).

/**
 * Thrown by {@link runAgent} when resuming with a `snapshot` + `event` whose
 * `type` the restored state cannot accept (a type-level check via
 * {@link getAcceptedEvents}). A programmer/integration error, in the same
 * class as runAgent's bind-time throws — it throws rather than settling an
 * `error` result. A type-legal event a guard rejects is NOT this error (the
 * machine simply takes no transition). Opt out with
 * {@link RunAgentOptions.onIllegalResumeEvent} `'ignore'`.
 */
export class AgentIllegalResumeEventError extends AgentError {
  readonly eventType: string;
  readonly acceptedTypes: string[];
  constructor(eventType: string, acceptedTypes: string[]) {
    super(
      "illegal-resume-event",
      `runAgent: cannot resume with event '${eventType}' — the restored state does not accept ` +
        `it. Accepted event types: ${acceptedTypes.length > 0 ? acceptedTypes.join(", ") : "(none)"}.`,
    );
    this.name = "AgentIllegalResumeEventError";
    this.eventType = eventType;
    this.acceptedTypes = acceptedTypes;
  }
}

/**
 * Thrown by {@link runAgent} when resuming from a `snapshot` whose stamped
 * `agentMeta.version` differs from the current machine's version, under the
 * default `onVersionMismatch: 'throw'` and with no `migrateSnapshot` hook. The
 * structural fingerprint of the machine changed since the snapshot was
 * persisted (a state/transition/invoke was added, removed, or retargeted), so
 * the snapshot may no longer resume cleanly. `from` is the snapshot's version,
 * `to` the current machine's.
 */
export class AgentSnapshotVersionMismatchError extends AgentError {
  readonly from: string;
  readonly to: string;
  readonly machineId: string;
  constructor(from: string, to: string, machineId: string) {
    super(
      "snapshot-version-mismatch",
      `runAgent: cannot resume snapshot stamped with machine version '${from}' against ` +
        `machine '${machineId}' at version '${to}' — the machine's structure changed since ` +
        `the snapshot was persisted. Provide options.migrateSnapshot to adapt it, or set ` +
        `options.onVersionMismatch to 'warn'/'ignore' to proceed anyway.`,
    );
    this.name = "AgentSnapshotVersionMismatchError";
    this.from = from;
    this.to = to;
    this.machineId = machineId;
  }
}

/**
 * Thrown by {@link generateResult} when the run settles `idle` instead of
 * `done`: the machine paused for external input. Carries the idle `snapshot`
 * and `acceptedTypes` (the event types that could resume it, via
 * {@link getAcceptedEvents}). Use {@link runAgent} directly when idle is an
 * expected outcome you handle.
 */
export class AgentIdleError extends AgentError {
  readonly snapshot: AnyMachineSnapshot;
  readonly acceptedTypes: string[];
  constructor(snapshot: AnyMachineSnapshot, acceptedTypes: string[]) {
    super(
      "agent-idle",
      `generateResult: the machine paused (idle) instead of completing. Resume it by ` +
        `calling runAgent with one of these events: ${
          acceptedTypes.length > 0 ? acceptedTypes.join(", ") : "(none)"
        }.`,
    );
    this.name = "AgentIdleError";
    this.snapshot = snapshot;
    this.acceptedTypes = acceptedTypes;
  }
}

/** Handler for `agent.userInput` invokes passed as {@link RunAgentOptions.userInput}. Resolves to what the human typed. */
export interface AgentUserInputExecutor {
  (input: AgentUserInput): PromiseLike<string>;
}

/**
 * The run's machine identity, stamped onto every settled snapshot's `agentMeta`.
 * `machineId` is the machine's `id`; `version` is
 * {@link RunAgentOptions.machineVersion} or the
 * {@link getMachineStructuralHash} of the machine. Trace events and the
 * `onMessage` info arg carry the same identity flattened, as
 * `machineId`/`machineVersion`.
 */
export interface AgentRunMeta {
  machineId: string;
  version: string;
}

/**
 * Second argument passed to {@link RunAgentOptions.onMessage}: the run's
 * identity, carried alongside each live message. Not stamped onto the message
 * itself (messages stay clean model input).
 */
export interface AgentMessageInfo {
  runId: string;
  machineId: string;
  /** {@link RunAgentOptions.machineVersion}, else the machine's own `version`, else its structural hash. */
  machineVersion: string;
}

/**
 * The version of the {@link AgentTraceEvent} envelope every trace event carries
 * as `schemaVersion`. Bumped only on a breaking change to the envelope or any
 * payload shape, so a consumer can gate on it. Emitted identically by
 * {@link runAgent}, {@link provideExecutors}' `onTrace`, and
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
  /** {@link RunAgentOptions.machineVersion}, else the machine's own `version`, else its structural hash. */
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
       * request opted into the structured-output envelope's `reasoning` field.
       * Present only when the executor surfaced a string `reasoning`. */
      reasoning?: string;
      /** This call's token usage, lifted off the raw executor result's `usage`.
       * Present only when the executor reported it. The run-level total is
       * {@link RunAgentResult.usage}. */
      usage?: AgentCallUsage;
    }
  | { type: "request.error"; request: AgentStepRequest; error: unknown }
  | { type: "stream.chunk"; request: AgentRequest; chunk: string }
  | {
      type: "machine.transition";
      snapshot: SnapshotFrom<TMachine>;
      event: EventFromLogic<TMachine>;
      /** Durable replay-entry id when this transition corresponds to one. */
      eventId?: string;
    }
  | { type: "emit"; event: EmittedFrom<TMachine> }
  | {
      /** A reserved `@agent.usage` event the run declined to deliver. The
       * tokens still fold into {@link RunAgentResult.usage}; only the machine
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
          pendingUserInputs?: PendingUserInput[];
          persistedSnapshot?: Snapshot<unknown>;
        }
      | {
          type: "run.end";
          status: "error";
          cause: RunAgentErrorCause;
          error: unknown;
          snapshot: SnapshotFrom<TMachine>;
        }
    )
);

/**
 * The JSON-safe projection of an {@link AgentTraceEvent} produced by
 * {@link serializeTraceEvent}: the envelope fields are unchanged, and every
 * payload field that can hold a live object (snapshots, machine events, request
 * objects, raw SDK results, errors) is narrowed to a {@link JsonValue}. Safe to
 * hand straight to `JSON.stringify` for a JSONL trace file.
 */
export type JsonSerializableTraceEvent = {
  schemaVersion: typeof AGENT_TRACE_SCHEMA_VERSION;
  runId: string;
  seq: number;
  timestamp: string;
  machineId: string;
  machineVersion: string;
} & (
  | { type: "run.start"; input?: JsonValue; snapshot?: JsonValue; event?: JsonValue }
  | { type: "request.start"; request: JsonValue }
  | {
      type: "request.end";
      request: JsonValue;
      output: JsonValue;
      /** Present only when `includeRaw` was set; the raw executor result, sanitized. */
      raw?: JsonValue;
      reasoning?: string;
      /** Present only when the executor reported it; plain numbers, passed through as-is. */
      usage?: JsonValue;
    }
  | { type: "request.error"; request: JsonValue; error: JsonValue }
  | { type: "stream.chunk"; request: JsonValue; chunk: string }
  | { type: "machine.transition"; snapshot: JsonValue; event: JsonValue; eventId?: string }
  | { type: "emit"; event: JsonValue }
  | { type: "usage.dropped"; event: JsonValue; reason: "settled" }
  | { type: "run.end"; status: "done"; output: JsonValue; snapshot: JsonValue }
  | {
      type: "run.end";
      status: "idle";
      snapshot: JsonValue;
      pendingUserInputs?: JsonValue;
      persistedSnapshot?: JsonValue;
    }
  | {
      type: "run.end";
      status: "error";
      cause: RunAgentErrorCause;
      error: JsonValue;
      snapshot: JsonValue;
    }
);

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
  "eventId",
  "reasoning",
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
 *   same JSON round-trip as {@link persistSnapshot}, so what lands on disk is
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
 * Options for {@link runAgent}.
 *
 * Host executors are passed as a single {@link AgentRequestExecutors}-shaped
 * set under `executors` (the same shape the step path takes). Each executor
 * kind is required only if the machine actually reaches a request of that kind
 * — checked at bind time, before any actor runs. The whole `executors` field is
 * optional: a machine whose agent sources all carry their own executor
 * (`.withExecutor(...)`) needs none.
 */
export interface RunAgentOptions<TMachine extends AnyStateMachine> {
  /**
   * The host executor set backing the machine's agent actors — build it with
   * `createAiSdkExecutors({ models })` from '@statelyai/agent/ai-sdk', or supply
   * `{ generateText?, streamText?, decide? }` by hand. Every slot is optional
   * here (unlike the step path's {@link AgentRequestExecutors}): each kind is
   * bind-time-checked only when the machine actually reaches a request of that
   * kind, so e.g. a stream-only machine may pass `{ streamText }` alone.
   */
  executors?: Partial<AgentRequestExecutors>;

  /** Machine input, passed straight to `createActor(machine, { input })`. Omit when resuming via `snapshot`. */
  input?: InputFrom<TMachine>;

  // resume
  /** A previously-settled run's `result.snapshot`, to resume from instead of starting fresh. Pair with `event` to deliver the event that unblocks the resumed idle state. */
  snapshot?: Snapshot<unknown>;
  /** An event to send immediately after starting/resuming the actor (e.g. the human's answer to an idle-state prompt). */
  event?: EventFromLogic<TMachine>;
  /**
   * A prior `runAgent` result's replayable `events`, copied as the prefix of
   * this result's event log. Pass this alongside `snapshot` + `event` when
   * resuming so the next result retains the complete, replayable history;
   * with a `snapshot` these events are history only (`snapshot` is the live
   * resume source).
   *
   * **Events-only resume:** with NO `snapshot` and a self-contained log (a
   * reserved `@agent.init` first entry — every log started by `runAgent` from
   * scratch has one), the resume snapshot is derived by replaying the log:
   * recorded model/tool results are reused, never re-executed, and a request
   * that was still in flight when the log ended re-executes idempotently on
   * restore. This is the crash-recovery path: persist entries via `onEvent`
   * (or an event-log store) and resume from the log alone.
   */
  events?: readonly AgentLogEntry[];
  /**
   * How to handle a resume `event` the restored state cannot accept (a
   * type-level check via {@link getAcceptedEvents}, only applied when resuming
   * from a `snapshot`). `'throw'` (default) throws {@link AgentIllegalResumeEventError}
   * before delivering the event; `'ignore'` restores the older silent behavior
   * (the event is sent and the machine drops it). A type-legal event a guard
   * rejects is never an illegal resume event.
   */
  onIllegalResumeEvent?: "throw" | "ignore";

  // version stamping
  /**
   * The version stamped onto every settled snapshot's `agentMeta` and compared
   * against an incoming snapshot's stamp on resume. Defaults to the machine's
   * own `version` (XState's `createMachine({ version })` prop) when set, else
   * {@link getMachineStructuralHash} of the machine (a structural fingerprint
   * that changes on any edit). Set `version` on the machine — or this option —
   * to control migration boundaries yourself.
   */
  machineVersion?: string;
  /**
   * How to handle a resume `snapshot` whose stamped `agentMeta.version` differs
   * from the current machine's version. `'throw'` (default) throws
   * {@link AgentSnapshotVersionMismatchError} with `from`/`to`; `'warn'`
   * `console.warn`s once and proceeds; `'ignore'` proceeds silently. Ignored
   * when {@link migrateSnapshot} is provided (that runs instead), and never
   * triggers for an unstamped snapshot (no `agentMeta`).
   */
  onVersionMismatch?: "throw" | "warn" | "ignore";
  /**
   * Called instead of {@link onVersionMismatch} when a resume snapshot's
   * version mismatches the current machine's: receives the incoming snapshot
   * and `{ from, to }`, and its return value is used as the snapshot to resume
   * from. A throw propagates.
   */
  migrateSnapshot?: (
    snapshot: Snapshot<unknown>,
    info: { from: string; to: string },
  ) => Snapshot<unknown>;

  // actor sources — sugar for machine.provide({ actors }) before the run
  /** Actor source implementations, merged onto the machine before binding — sugar for `machine.provide({ actors })` ahead of the run. */
  actors?: Record<string, AnyActorLogic>;

  /**
   * Optional human-input handler for `agent.userInput` invokes (CLI prompt,
   * web form, Slack, …). With a handler, input is gathered inline without
   * settling. Without one, an `agent.userInput` invoke becomes a *pending
   * placeholder*: it waits indefinitely, does not block idle detection, and
   * the run settles `{ status: 'idle', pendingUserInputs, persistedSnapshot }`
   * once no other work is in flight — resume by passing `persistedSnapshot`
   * back as `snapshot` together with a `userInput` handler that answers it.
   */
  userInput?: AgentUserInputExecutor;

  /**
   * Host override for detecting a snapshot that is an INTENTIONAL wait for an
   * external event — the deterministic replacement for the timing heuristic
   * runAgent uses to settle idle. Resolution order: this option (host override)
   * → the machine-carried predicate declared via `setupAgent({ isSuspended })`
   * → the timing heuristic (when neither is present). When the resolved
   * predicate returns true and nothing is in flight (no live requests/
   * invokes; the `agent.userInput` placeholder exemption still applies), runAgent
   * settles idle immediately, without the `setTimeout` heuristic. It does NOT
   * force-settle while agent work is in flight, and whole-machine idle semantics
   * are unchanged; a machine with no predicate falls back to the heuristic
   * exactly as before (with a one-time dev warning suggesting a predicate).
   * Declare your own signal, e.g. `(s) => s.hasTag('awaiting-review')`.
   */
  isSuspended?: (snapshot: AnyMachineSnapshot) => boolean;

  // interpretation — the override to the default invoke-driven contract
  /**
   * The override to runAgent's DEFAULT contract. By default agent work is
   * whatever the machine *invokes* (`agent.generateText`, TextLogic,
   * `agent.decide`, …). With `getRequests`, whenever the machine would
   * otherwise settle idle, this hook reads the snapshot and returns the model
   * request(s) to run instead — prompts from state `description`s, `meta`,
   * tags, a lookup table keyed by state value, wherever you keep them. Return
   * nothing to settle idle (human-wait states).
   *
   * There is no blessed source for the prompts — this is a recipe seam.
   * Prompts-in-descriptions, copy-paste and adapt:
   *
   * ```ts
   * getRequests: (snapshot) =>
   *   snapshot._nodes
   *     .filter((node) => node.description && !node.tags.includes('waiting'))
   *     .map((node) => ({
   *       model: 'writer',
   *       prompt: node.description!,
   *       kind: node.tags.includes('decision') ? 'decision' : 'text',
   *       // single-outcome states advance deterministically; else `decide`
   *       onDone: node.ownEvents.length === 1 ? { type: node.ownEvents[0] } : undefined,
   *       allowedEvents: node.ownEvents,
   *     })),
   * ```
   *
   * Each request runs per {@link AgentStateRequest.kind}, appends to the
   * run's message log (see {@link RunAgentOptions.messages}), and advances
   * the machine per {@link AgentStateRequest.onDone} — explicitly named/
   * computed event, or a `decide` call when omitted — always gated by
   * `snapshot.can`. Multiple requests run concurrently (parallel regions —
   * scope each with `allowedEvents`, e.g. the node's `ownEvents`). A pass
   * that sends no event settles idle. Every model call counts against
   * `maxModelCalls`.
   */
  getRequests?: (
    snapshot: SnapshotFrom<TMachine>,
    // Named to disambiguate from the machine's own `context`.
    agentContext: { messages: readonly AgentMessage[] },
  ) => AgentStateRequest | readonly AgentStateRequest[] | undefined;
  /**
   * Adds to the run's aggregated message log (the working memory
   * `getRequests` requests read and append to). The log starts as the resume
   * `snapshot`'s stamped `messages` (else `[]`); an ARRAY here is APPENDED to
   * that history — the safe default for folding in a user reply on resume,
   * never silently erasing prior conversation. Pass a FUNCTION
   * `(prior) => AgentMessage[]` to take full control (replace, filter,
   * compact). The final log is stamped onto every settled result's
   * `snapshot.messages` (like `agentMeta`), so persist/resume round-trips it
   * with no extra wiring — read it with `getAgentMessages(snapshot)`.
   */
  messages?: AgentMessage[] | ((prior: AgentMessage[]) => AgentMessage[]);

  // observation — all void; no callback controls the run
  /** Fires for each streamed chunk of a `mode: 'stream'` text request, alongside the {@link AgentRequest} that produced it (parallel states can interleave multiple streams). Purely observational. */
  onChunk?: (chunk: string, info: { request: AgentRequest }) => void;
  /** Fires once per resolved text/decision request with its normalized output and the raw executor result (tool calls, usage, …) — the seam for tracing/observability and event-sourced replay logging. */
  onResult?: (request: AgentStepRequest, result: { output: unknown; raw: unknown }) => void;
  /**
   * Fires as each new replayable external input is appended to this run's
   * event log. A fresh run begins with `@agent.init`; raised and other internal
   * events are excluded. History supplied through {@link events} is not
   * re-emitted. Purely observational, like {@link onTransition}.
   */
  onEvent?: (entry: AgentLogEntry) => void;
  /** Fires a single ordered stream of run/request/chunk/transition/emit/end events. Intended for eval traces, JSONL logs, and adapter-owned telemetry/exporters. */
  onTrace?: (event: AgentTraceEvent<TMachine>) => void;
  /**
   * Fires on every machine transition (snapshot + causing event). Pure
   * observation — progress UIs, logging, tracing. Cannot send events.
   */
  onTransition?: (snapshot: SnapshotFrom<TMachine>, event: EventFromLogic<TMachine>) => void;
  /**
   * Fires for each message appended to the run's aggregated log (see
   * {@link RunAgentOptions.messages}) the moment a `getRequests` request
   * appends it — the live view of the log a caller otherwise only reads off
   * the settled snapshot via `getAgentMessages`. Purely observational, like
   * {@link onTransition}. Never fires for the seeded history, and never fires
   * on a default invoke-driven run (nothing appends there).
   */
  onMessage?: (message: AgentMessage, info: AgentMessageInfo) => void;
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
  /** Caps the number of model/decision calls this run may make (each retry of a decision counts separately); exceeding it settles `{ status: 'error', cause: 'max-model-calls' }`. Default 100. */
  maxModelCalls?: number; // default 100
  /** Aborts the run; settles `{ status: 'error', cause: 'aborted' }` with `signal.reason` as the error. */
  signal?: AbortSignal;
}

/**
 * The outcome of a {@link runAgent} call — always exactly one of three
 * variants, never a throw for a waiting or failed machine (programmer
 * errors like a missing executor still throw, at bind time before any actor
 * runs). `done`: a final state was reached (`output` is the machine's
 * `OutputFrom`). `idle`: the run settled with no in-flight work — resume by
 * calling `runAgent` again with `{ snapshot, event }`. `error`: a run-level
 * failure, discriminated by `cause` (`'aborted'`, `'max-model-calls'`,
 * `'decision-exhausted'`, `'machine'` for any other machine error state, or
 * `'stopped'` for an external stop — see {@link RunAgentErrorCause}). Every
 * variant carries the final `snapshot` plus a replayable `events` array. The
 * underlying actor is stopped on every settle path — there is no live actor to
 * resume; resume is always by snapshot.
 */
/** A pending unhandled `agent.userInput` invoke surfaced on an idle settle — `id` is the invoke's id, `input` its resolved invoke input (prompt, metadata). Answer it by resuming with a `userInput` handler. */
export interface PendingUserInput {
  id: string;
  input: AgentUserInput | undefined;
}

type RunAgentOutcome<TMachine extends AnyStateMachine> =
  | { status: "done"; output: OutputFrom<TMachine>; snapshot: SnapshotFrom<TMachine> }
  | {
      status: "idle";
      snapshot: SnapshotFrom<TMachine>;
      /** Present when the machine is waiting on unhandled `agent.userInput` invokes: one entry per pending invoke. */
      pendingUserInputs?: PendingUserInput[];
      /**
       * The JSON-serializable persisted snapshot (in-flight children included,
       * WITH their own state). Persist THIS one and resume with
       * `runAgent(machine, { snapshot: persistedSnapshot, ... })` — the live
       * `snapshot` above cannot round-trip active children, so resuming from
       * it restarts every invoked child from scratch.
       */
      persistedSnapshot: Snapshot<unknown>;
    }
  | {
      status: "error";
      cause: RunAgentErrorCause;
      error: unknown;
      snapshot: SnapshotFrom<TMachine>;
    };

export type RunAgentResult<TMachine extends AnyStateMachine> = RunAgentOutcome<TMachine> & {
  /**
   * Versioned, JSON-safe envelopes around replayable external inputs observed
   * through this run: machine input, effect completions/failures, user events,
   * and timer firings. Raised/internal events are excluded because replay
   * re-derives them. Each entry carries timestamp, machine identity/version,
   * and strict replay hashes.
   *
   * A fresh run starts with `@agent.init`. When resuming from a snapshot, pass
   * the preceding result's `events` through {@link RunAgentOptions.events} to
   * retain a self-contained history.
   */
  events: AgentLogEntry[];
  /**
   * Aggregated model-call usage for THIS run — `modelCalls` plus the token
   * fields every executor reported (see {@link AgentUsage} for the
   * partial-sum rule). Present on all three variants: an `idle` or `error`
   * result accounts for the calls made before the run settled.
   *
   * A resumed run counts only its own calls, not the history behind
   * `snapshot`/`events`.
   */
  usage: AgentUsage;
};

/**
 * Discriminates a {@link RunAgentResult} `error`:
 * - `'aborted'` — the run's `signal` fired.
 * - `'max-model-calls'` — the `maxModelCalls` budget was exceeded.
 * - `'decision-exhausted'` — the machine reached an error state whose error is
 *   (or wraps) a {@link AgentDecisionExhaustedError} that no `onError` handled.
 * - `'machine'` — any other machine error state.
 * - `'stopped'` — the actor was stopped externally (`status === 'stopped'`).
 */
export type RunAgentErrorCause =
  | "aborted"
  | "max-model-calls"
  | "decision-exhausted"
  | "machine"
  | "stopped";

// Thrown internally by consumeModelCall() past the budget; caught by runAgent's settle loop to produce a 'max-model-calls' error result.
let nextRunAgentTraceId = 1;

class AgentMaxModelCallsExceededError extends AgentError {
  constructor() {
    super("max-model-calls-exceeded", "runAgent exceeded maxModelCalls.");
    this.name = "AgentMaxModelCallsExceededError";
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
function isStateMachine(logic: unknown): logic is AnyStateMachine {
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
 * machine invokes an agent actor `runAgent` cannot execute. See §3.2 point 2.
 *
 * Recurses into invoked child state machines (arbitrarily deep). A child
 * machine's agent requests reached through string-keyed invoke srcs DO inherit
 * the parent runAgent's `generateText`/`streamText`/`decide` executors —
 * runAgent rebinds them with the same host-backed wrappers (see
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
  options: { hasGenerateText: boolean; hasDecide: boolean; hasStreamText: boolean },
): void {
  assertMachineBindable(machine, effectiveSources, options, {
    isChild: false,
    childPath: "",
    rebindable: true,
    visited: new Set([machine]),
  });
}

/** Recursion frame for {@link assertBindable}. `isChild` flips the error
 * messages to name the child invoke chain; `childPath` names that chain
 * (`parent > child`); `rebindable` is true while every link back to the root
 * is a string-keyed source (so runAgent can rebind the request with its own
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
  options: { hasGenerateText: boolean; hasDecide: boolean; hasStreamText: boolean },
  ctx: BindWalkContext,
): void {
  const invokes: Array<{ stateName: string; src: string | AnyActorLogic }> = [];
  collectConfiguredInvokeSrcs(machine.config as never, machine.config.id ?? "(root)", invokes);

  const where = ctx.isChild ? `child machine '${ctx.childPath}' state` : "state";

  for (const { stateName, src } of invokes) {
    if (typeof src !== "string") {
      // Direct-object src.
      if (isStateMachine(src)) {
        assertChildMachineBindable(src, src, stateName, options, ctx);
        continue;
      }
      // string-keyed sources can be rebound by runAgent; direct objects
      // cannot. Only a problem if it's an agent logic that still needs
      // execution (no executor of its own).
      if ((isTextLogic(src) || isDecisionLogic(src)) && !executorBoundLogics.has(src as object)) {
        throw new Error(
          `runAgent: ${where} '${stateName}' invokes a direct-object actor logic ` +
            `(kind: '${(src as TextLogic | DecisionLogic).kind}'). Direct-object invoke ` +
            `srcs cannot be rebound by runAgent — either call '.withExecutor(...)' on ` +
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
        `runAgent: ${where} '${stateName}' invokes unregistered actor source '${src}'. ` +
          `Provide it via machine.provide({ actors: { '${src}': ... } }) or ` +
          `runAgent(machine, { actors: { '${src}': ... } }).`,
      );
    }

    if (isStateMachine(logic)) {
      assertChildMachineBindable(logic, src, stateName, options, ctx);
      continue;
    }

    if (src === USER_INPUT_ACTOR) {
      // Handled or not, `agent.userInput` is always bindable: without a
      // `userInput` option or actor source it is bound as a pending
      // placeholder that settles the run idle (see the binding step below).
      // (Only meaningful for the top-level machine — a child machine's own
      // userInput placeholder still binds harmlessly.)
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
      if (!options.hasDecide) {
        throw new Error(
          `runAgent: ${where} '${stateName}' invokes decision source '${src}' but no ` +
            `'decide' executor was provided to runAgent(...).`,
        );
      }
      continue;
    }

    if (isTextLogic(logic)) {
      // A text source with its own bound executor (`.withExecutor(...)`) needs
      // no runAgent executor — it runs itself.
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
      if (logic.mode === "stream" && !options.hasStreamText) {
        throw new Error(
          `runAgent: ${where} '${stateName}' invokes streaming text source '${src}' but ` +
            `no 'streamText' executor was provided to runAgent(...).`,
        );
      }
      if (logic.mode !== "stream" && !options.hasGenerateText) {
        throw new Error(
          `runAgent: ${where} '${stateName}' invokes text source '${src}' but ` +
            `no 'generateText' executor was provided to runAgent(...).`,
        );
      }
      continue;
    }

    if (isUnboundPlaceholder(logic)) {
      throw new Error(
        `runAgent: ${where} '${stateName}' invokes actor source '${src}', which has no ` +
          `host execution. Provide it via machine.provide({ actors: { '${src}': ... } }) ` +
          `or runAgent(machine, { actors: { '${src}': ... } }).`,
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
  options: { hasGenerateText: boolean; hasDecide: boolean; hasStreamText: boolean },
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
  // runAgent rebinds the child's unbound requests with its own executors. A
  // direct-object invoke src (typeof childSrc !== "string") can't be swapped,
  // so nothing under it inherits.
  const rebindable = ctx.rebindable && typeof childSrc === "string";

  assertMachineBindable(childMachine, childSources, options, {
    isChild: true,
    childPath,
    rebindable,
    visited: new Set([...ctx.visited, childMachine]),
  });
}

/** The loud bind-time error for an unbound agent request reached under a
 * direct-object invoke src, which runAgent cannot rebind (only string-keyed
 * sources can be swapped via `.provide`). Names the invoke chain AND the
 * request src, and spells out the `.withExecutor`/string-keyed remedy. Note:
 * requests reachable through string-keyed srcs at any depth DO inherit
 * runAgent's executors — this error is only for the unrebindable direct-object
 * case. */
function unrebindableChildRequestError(
  childPath: string,
  stateName: string,
  requestSrc: string,
  kind: "text" | "streaming text" | "decision",
): Error {
  return new Error(
    `runAgent: child machine '${childPath}' (state '${stateName}') invokes ${kind} ` +
      `source '${requestSrc}', which has no host execution and is reached through a ` +
      `direct-object invoke src that runAgent cannot rebind. Requests reached through ` +
      `string-keyed actor sources inherit runAgent's generateText/streamText/decide ` +
      `executors automatically; a direct-object child machine does not. Either bind the ` +
      `request with its own executor (requestLogic.withExecutor(...)), or register the ` +
      `child as a string-keyed actor source (machine.provide({ actors: { <child>: ` +
      `childMachine } })) and invoke it by name.`,
  );
}

/** Attribution a call site attaches to the reserved `@agent.usage` event it reports — everything on {@link AgentUsageEvent} except the type and the tokens. @internal */
type AgentUsageEventSource = Omit<AgentUsageEvent, "type" | "usage">;

// Shared state closed over by every wrapped actor source in one runAgent call: executors, observation callbacks, and the shared model-call budget/actor ref.
/** @internal */
interface RunAgentBindContext {
  generateText?: AgentRequestExecutor;
  streamText?: AgentRequestExecutor;
  decide?: AgentDecisionExecutor;
  onChunk?: (chunk: string, info: { request: AgentRequest }) => void;
  onResult?: (request: AgentStepRequest, result: { output: unknown; raw: unknown }) => void;
  /**
   * Payload-level trace sink: the shared emission helpers hand it a bare
   * {@link AgentTraceEventPayload} plus the emitting actor's `self` (the invoked
   * async leaf). `runAgent` ignores `self` and stamps a run-scoped envelope;
   * `provideExecutors` uses it to mint a per-root-actor envelope (see
   * `provideTraceSink`).
   */
  onTrace?: (event: AgentTraceEventPayload, self?: unknown) => void;
  consumeModelCall: () => void;
  /**
   * Folds one completed call's reported usage into the run-level
   * {@link AgentUsage} AND — when the machine declares a transition for it —
   * delivers the reserved {@link AGENT_USAGE_EVENT_TYPE} event carrying
   * `usage` plus `source` as attribution.
   *
   * `self` is the settling request's own actor ref; the `provideExecutors`
   * path reads the invoking machine actor off it (`self._parent`) because it
   * has no run-scoped root actor. `runAgent` ignores it and delivers to the
   * run's root.
   */
  recordUsage?: (usage: AgentCallUsage, source?: AgentUsageEventSource, self?: unknown) => void;
  /** The owning run's id (`run_<n>`), threaded to executors as `info.runId`. Unset off the runAgent path. */
  runId?: string;
  /** Assigned right after createActor (§2.6); read lazily by decision wraps. */
  actorHolder: { actorRef: AnyActorRef | undefined };
  /** Registered `setupAgent` schemas (for event `inputSchema`s), if any. */
  schemas?: AgentSchemas;
}

/**
 * True when the snapshot's active states declare a transition for the reserved
 * `'@agent.usage'` type EXPLICITLY. A catch-all `on: { '*': … }` deliberately
 * does not count: a wildcard is a machine's own event vocabulary, not an
 * opt-in to a library-reserved event, and `snapshot.can(event)` alone cannot
 * tell the two apart (it answers "would this event be taken?", which a
 * wildcard makes true for everything). Gating delivery on the explicit
 * declaration is what keeps `@agent.usage` opt-in by construction — and keeps
 * a wildcard machine's context and event log byte-identical to a run without
 * the feature. @internal
 */
function declaresUsageTransition(snapshot: AnyMachineSnapshot): boolean {
  return getNextTransitions(snapshot).some(
    (transition) => transition.eventType === AGENT_USAGE_EVENT_TYPE,
  );
}

/** Reads the durable invoke id/src off the async actor's own ref (`self`). */
function selfIdAndSrc(self: unknown): { id: string; src: string } {
  const ref = self as { id?: unknown; src?: unknown } | undefined;
  return {
    id: typeof ref?.id === "string" ? ref.id : "",
    src: typeof ref?.src === "string" ? ref.src : "",
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
function invokingActorOf(self: unknown, runCtx: RunAgentBindContext): AnyActorRef | undefined {
  const parent = (self as { _parent?: AnyActorRef } | undefined)?._parent;
  return parent ?? runCtx.actorHolder.actorRef;
}

/**
 * The shared text/stream emission helper: binds a {@link TextLogic} to
 * `runCtx`'s executor and constructs the `request.start` / `stream.chunk` /
 * `request.end` (incl. the lifted `reasoning`) / `request.error` trace payloads.
 * Used by both `runAgent` and `provideExecutors` so the two paths produce
 * identical event shapes by construction. @internal
 */
function wrapTextLogicForRunAgent(logic: TextLogic, runCtx: RunAgentBindContext): TextLogic {
  return logic.withExecutor(async ({ request, self, signal }) => {
    const { id, src } = selfIdAndSrc(self);
    const executor = logic.mode === "stream" ? runCtx.streamText : runCtx.generateText;
    if (!executor) {
      throw new Error(
        `runAgent: no '${logic.mode === "stream" ? "streamText" : "generateText"}' ` +
          "executor provided.",
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
    runCtx.onTrace?.({ type: "request.start", request: agentRequest }, self);
    try {
      const raw = await executor(requestWithTools as AgentExecutorTextRequest, {
        onChunk: (chunk: string) => {
          runCtx.onTrace?.({ type: "stream.chunk", request: agentRequest, chunk }, self);
          runCtx.onChunk?.(chunk, { request: agentRequest });
        },
        signal,
        ...(runCtx.runId !== undefined ? { runId: runCtx.runId } : {}),
        ...(id !== "" ? { requestId: id } : {}),
      });
      const output = await normalizeGeneratorResult(raw, id, {
        request,
        onChunk: (chunk: string) => {
          runCtx.onTrace?.({ type: "stream.chunk", request: agentRequest, chunk }, self);
          runCtx.onChunk?.(chunk, { request: agentRequest });
        },
      });

      // Lift `reasoning` off the raw executor result (structured-output
      // envelope opt-in) onto the request.end trace — never into machine output.
      const rawReasoning = (raw as { reasoning?: unknown } | null | undefined)?.reasoning;
      const reasoning = typeof rawReasoning === "string" ? rawReasoning : undefined;

      // Fold this call's reported tokens into the run-level AgentUsage, and
      // surface them per-call on the request.end trace.
      const usage = extractCallUsage(raw);
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

      runCtx.onResult?.(agentRequest, { output, raw });
      runCtx.onTrace?.(
        {
          type: "request.end",
          request: agentRequest,
          output,
          raw,
          ...(reasoning !== undefined ? { reasoning } : {}),
          ...(usage !== undefined ? { usage } : {}),
        },
        self,
      );

      return { output };
    } catch (error) {
      runCtx.onTrace?.({ type: "request.error", request: agentRequest, error }, self);
      throw error;
    }
  });
}

// Wraps runCtx's `decide` executor with model-call budgeting and tracing.
// `self` is the invoking decision leaf actor, threaded to `onTrace` so the
// provide path can attribute the event to its root actor.
function createCountingDecide(
  runCtx: RunAgentBindContext,
  self: unknown,
  kind: "decision" = "decision",
): AgentDecisionExecutor {
  return async (attemptRequest) => {
    runCtx.consumeModelCall();
    runCtx.onTrace?.({ type: "request.start", request: attemptRequest }, self);
    try {
      // `runId` rides on the request like `signal` does: host-injected
      // correlation, never serialized into machine state.
      const result = await runCtx.decide!(
        runCtx.runId !== undefined ? { ...attemptRequest, runId: runCtx.runId } : attemptRequest,
      );
      const usage = extractCallUsage(result);
      if (usage) {
        const { src } = selfIdAndSrc(self);
        runCtx.recordUsage?.(
          usage,
          {
            kind,
            ...(attemptRequest.id ? { id: attemptRequest.id } : {}),
            ...(src !== "" ? { src } : {}),
            model: attemptRequest.model,
          },
          self,
        );
      }
      runCtx.onResult?.(attemptRequest, { output: result.event, raw: result });
      runCtx.onTrace?.(
        {
          type: "request.end",
          request: attemptRequest,
          output: result.event,
          raw: result,
          ...(usage !== undefined ? { usage } : {}),
        },
        self,
      );
      return result;
    } catch (error) {
      runCtx.onTrace?.({ type: "request.error", request: attemptRequest, error }, self);
      throw error;
    }
  };
}

/**
 * Builds the decision actor logic runAgent installs in place of a
 * `DecisionLogic`/`agent.decide` source. `DecisionLogic.withExecutor(...)`
 * can only swap the innermost per-attempt executor — the `resolveDecision(...)`
 * call (and its `canTake`) is hardwired inside the original logic's `run`.
 * To supply `canTake` (mode-3, §2.6), runAgent instead builds a fresh async
 * logic here that calls `resolveDecision` itself, reusing `logic.request(...)`
 * to build the request the same way the original logic would have.
 *
 * On success it SENDS the chosen event to the invoking actor (auto-delivery)
 * and then completes with that event
 * as its output — so callers never wire an `onDone` to deliver it. See the
 * send-then-complete note inside `run` for how exit-cancels-invoke interacts
 * with `onDone`.
 */
function createRunAgentDecisionLogic(
  logic: DecisionLogic,
  runCtx: RunAgentBindContext,
): DecisionLogic {
  const decisionLogic = createAsyncLogic<ChosenEvent, unknown>({
    run: async ({ input, signal, self }) => {
      if (!runCtx.decide) {
        throw new Error("runAgent: no 'decide' executor provided.");
      }
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

      const request: AgentDecisionRequest = { ...logic.request(input as never), id, events };

      const chosen = await resolveDecision(request, createCountingDecide(runCtx, self), {
        maxRetries: logic.maxRetries,
        signal,
        canTake: (event) =>
          actorRef ? (actorRef.getSnapshot() as AnyMachineSnapshot).can(event) : true,
      });

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
      createRunAgentDecisionLogic(logic.withExecutor(nextExecute), runCtx),
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
function rootActorOf(self: unknown): AnyActorRef | undefined {
  let ref = self as { _parent?: unknown } | undefined;
  if (!ref) {
    return undefined;
  }
  while ((ref as { _parent?: unknown })._parent) {
    ref = (ref as { _parent?: unknown })._parent as { _parent?: unknown };
  }
  return ref as unknown as AnyActorRef;
}

/** The per-root envelope state, minted on first use (runId `run_<n>`, matching runAgent). */
function rootTraceState(root: AnyActorRef): RootTraceState {
  let state = rootTraceRegistry.get(root as object);
  if (!state) {
    const logic = (root as { logic?: AnyStateMachine }).logic;
    const machineId =
      (logic?.config as { id?: string } | undefined)?.id ?? logic?.id ?? "(machine)";
    const machineVersion = logic ? getMachineStructuralHash(logic) : "";
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

/** Adapts a public `onTrace` into the payload-level {@link RunAgentBindContext.onTrace} sink used by the shared emission helpers. */
function provideTraceSink(
  onTrace?: (event: AgentTraceEvent) => void,
): RunAgentBindContext["onTrace"] {
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
 * `createActor`): the same wrappers runAgent installs, MINUS the run-scoped
 * model-call counter. `consumeModelCall` is a no-op (no budget), and
 * `actorHolder.actorRef` is left undefined — the wrappers read the invoking
 * actor off `self._parent`, always present under a live `createActor` tree.
 * `onTrace` (when given) mints a per-root-actor envelope. `schemas` come from
 * the machine's registered `setupAgent` execution options.
 *
 * `recordUsage` has no run-level aggregate to fold into here (there is no
 * run), so it does one thing: deliver the reserved `@agent.usage` event, gated
 * exactly like runAgent's — see {@link deliverUsageToInvokingActor}.
 */
function provideBindContext(
  machine: AnyStateMachine,
  executors: Partial<AgentRequestExecutors>,
  options: ProvideBindOptions,
): RunAgentBindContext {
  return {
    generateText: executors.generateText,
    streamText: executors.streamText,
    decide: executors.decide,
    onChunk: options.onChunk ? (chunk) => options.onChunk!(chunk) : undefined,
    onTrace: provideTraceSink(options.onTrace),
    consumeModelCall: () => {},
    recordUsage: (usage, source, self) => {
      deliverUsageToInvokingActor(usage, source ?? {}, self);
    },
    actorHolder: { actorRef: undefined },
    schemas: getRegisteredAgentExecutionOptions(machine).schemas,
  };
}

/**
 * `provideExecutors`' counterpart to runAgent's `deliverUsageEvent`: after a
 * bound call settles with reported usage, send the reserved
 * `@agent.usage` event to the machine actor that INVOKED the request — read
 * off the settling request actor's `self._parent`, which under a live
 * `createActor` tree is always the invoking machine (there is no run-scoped
 * root actor on this path).
 *
 * Gated identically to runAgent: the invoking snapshot must be active, must
 * declare an `'@agent.usage'` transition EXPLICITLY (see
 * {@link declaresUsageTransition} — a catch-all `on: { '*' }` is not an opt-in),
 * and must be able to take the event. There is no cycle to settle in
 * uncontrolled mode, so there are no dropped stragglers.
 *
 * Delivery follows `provideExecutors`' binding boundary: only sources IT bound
 * report here, so an invoked child machine that was not itself passed through
 * `provideExecutors` reports nothing. @internal
 */
function deliverUsageToInvokingActor(
  usage: AgentCallUsage,
  source: AgentUsageEventSource,
  self: unknown,
): void {
  const actorRef = (self as { _parent?: AnyActorRef } | undefined)?._parent;
  if (!actorRef) {
    return;
  }
  const snapshot = actorRef.getSnapshot() as AnyMachineSnapshot;
  if (snapshot?.status !== "active" || !declaresUsageTransition(snapshot)) {
    return;
  }
  const event: AgentUsageEvent = { type: AGENT_USAGE_EVENT_TYPE, ...source, usage };
  if (!snapshot.can(event as never)) {
    return;
  }
  actorRef.send(event as never);
}

/**
 * Host-binds one text/stream source for {@link provideExecutors} using the SAME
 * emission helper as `runAgent` ({@link wrapTextLogicForRunAgent}), so a bound
 * text request emits request.start/stream.chunk/request.end/request.error with
 * identical shapes. @internal
 */
export function bindTextForProvide(
  machine: AnyStateMachine,
  logic: TextLogic,
  executors: Partial<AgentRequestExecutors>,
  options: ProvideBindOptions,
): TextLogic {
  return wrapTextLogicForRunAgent(logic, provideBindContext(machine, executors, options));
}

/**
 * Host-binds one `DecisionLogic`/`agent.decide` source for
 * {@link provideExecutors}: runAgent's decision wrapper (snapshot-driven
 * candidate events, `canTake`, auto-delivery of the chosen event) with the same
 * request-level tracing runAgent emits, minus run-scoped counting. @internal
 */
export function bindDecisionForProvide(
  machine: AnyStateMachine,
  logic: DecisionLogic,
  executors: Partial<AgentRequestExecutors>,
  options: ProvideBindOptions,
): DecisionLogic {
  return createRunAgentDecisionLogic(logic, provideBindContext(machine, executors, options));
}

/**
 * Recursively rebinds an invoked child machine's own agent sources with the
 * SAME host-backed wrappers runAgent applies to the top-level machine, so a
 * child's text/stream/decision requests inherit runAgent's executors and
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
): AnyStateMachine {
  if (visited.has(childMachine)) {
    return childMachine;
  }
  const childVisited = new Set([...visited, childMachine]);
  const sources = childMachine.sources.actors as Record<string, AnyActorLogic>;
  const wrapped: Record<string, AnyActorLogic> = {};

  for (const [key, logic] of Object.entries(sources)) {
    if (isDecisionLogic(logic)) {
      if (!executorBoundLogics.has(logic as object)) {
        wrapped[key] = createRunAgentDecisionLogic(logic, runCtx);
      }
      continue;
    }
    if (isTextLogic(logic)) {
      if (!executorBoundLogics.has(logic as object)) {
        wrapped[key] = wrapTextLogicForRunAgent(logic, runCtx);
      }
      continue;
    }
    if (isStateMachine(logic)) {
      const rebound = rebindChildMachine(logic, runCtx, childVisited);
      if (rebound !== logic) {
        wrapped[key] = rebound;
      }
      continue;
    }
    // Non-agent actors, `agent.userInput`, and placeholders pass through
    // untouched (child userInput is not given the top-level HITL placeholder).
  }

  return Object.keys(wrapped).length > 0
    ? (childMachine.provide({ actors: wrapped as never }) as AnyStateMachine)
    : childMachine;
}

/**
 * Runs an agent machine to completion or idle: a `createActor` host that
 * binds `options`' host executors onto the machine's `agent.*`/`TextLogic`/
 * `DecisionLogic` actor sources, starts (or resumes) the actor, and drives
 * it until it settles — {@link RunAgentResult} `done | idle | error`. Unlike
 * the step helpers ({@link initialAgentStep} etc — a pure
 * transition-at-a-time path for durable hosts), `runAgent` owns a live actor
 * internally; there is no continuation callback, so **idle always settles**
 * and the caller resumes explicitly by passing the settled `{ snapshot,
 * event }` back in. The actor is stopped on every settle path (`done`,
 * `idle`, and `error` alike) — resume is always by snapshot, never by
 * holding a reference to a live actor.
 *
 * Binding happens **before** the actor starts: every invoke the machine
 * could reach is walked and checked against the effective actor sources
 * (`options.actors` merged onto the machine), so a missing
 * `streamText`/`decide` executor or any other unbound actor source throws
 * immediately — a bind-time error, not a mid-run failure. The one exception
 * is `agent.userInput`: unhandled, it binds as a pending placeholder that
 * settles the run idle (with `pendingUserInputs`) instead of erroring.
 *
 * @example
 * ```ts
 * const executors = createAiSdkExecutors({ models });
 * let r = await runAgent(machine, { input, executors });
 * while (r.status === 'idle') {
 *   const event = await promptUser(getAcceptedEvents(r.snapshot));
 *   r = await runAgent(machine, { snapshot: r.snapshot, event, executors });
 * }
 * if (r.status !== 'done') throw new Error(`Run did not complete: ${r.status}`);
 * console.log(r.output);
 * ```
 *
 * The `executors`' `generateText`/`streamText` accept the raw Vercel AI SDK
 * functions directly (`executors: { generateText, streamText }` with them
 * imported from `ai`) — their `{ text }`/`{ textStream }` results are unwrapped
 * natively. `decide` cannot be a raw AI SDK function: the tool-per-event mapping
 * lives in an adapter — use `createAiSdkExecutors` from '@statelyai/agent/ai-sdk'.
 */
export async function runAgent<TMachine extends AnyStateMachine>(
  machine: TMachine,
  options: RunAgentOptions<TMachine>,
): Promise<RunAgentResult<TMachine>> {
  return createAgentSession(machine, options, { oneShot: true }).settled();
}

/**
 * A long-lived agent session returned by {@link createAgentActor}: the same
 * engine as {@link runAgent} (executor binding at any depth, the replayable
 * event log, budgets, traces), but the actor stays alive across idle settles.
 *
 * One **cycle** runs from start (or the event that re-opened the session) to
 * the next quiescence. `settled()` resolves with the current cycle's
 * {@link RunAgentResult}; after an `idle` settle, sending the actor an event
 * re-opens the cycle and the next `settled()` call tracks it. The event log
 * spans the whole session — every turn appends to one replayable history.
 * `done`, `error`, and external stop are final: the actor stops and every
 * later `settled()` resolves with that final result.
 */
export interface AgentActorSession<TMachine extends AnyStateMachine> {
  /** The live bound actor. Drive it directly: `session.actor.send(event)`. */
  actor: ReturnType<typeof createActor<TMachine>>;
  /** The session's replayable event log (live; grows across cycles). */
  readonly events: readonly AgentLogEntry[];
  /** Cumulative session usage (all cycles). */
  usage(): AgentUsage;
  /** Resolves with the current cycle's settled result (`done | idle | error`). */
  settled(): Promise<RunAgentResult<TMachine>>;
  /** Stops the actor. A not-yet-settled cycle settles `error`/`stopped`. */
  stop(): void;
}

/**
 * Session mode: {@link runAgent}'s engine with a long-lived actor. Use it when
 * the agent is a *session* fed by external events (chat turns, device or
 * timer events, a socket) rather than a one-shot job — you keep the log,
 * budget, traces, and idle semantics that bare `provideExecutors` +
 * `createActor` would forfeit.
 *
 * ```ts
 * const session = createAgentActor(machine, { input, executors });
 * let result = await session.settled();          // first quiescence
 * while (result.status === "idle") {
 *   session.actor.send(await nextUserEvent(result.snapshot));
 *   result = await session.settled();            // next quiescence, same log
 * }
 * session.stop();
 * ```
 *
 * Accepts the same options as {@link runAgent} (including `snapshot`/`events`
 * resume). Not yet supported in session mode: `getRequests` re-interpretation
 * across cycles behaves per-cycle exactly as in `runAgent`.
 */
export function createAgentActor<TMachine extends AnyStateMachine>(
  machine: TMachine,
  options: RunAgentOptions<TMachine>,
): AgentActorSession<TMachine> {
  return createAgentSession(machine, options, { oneShot: false });
}

function createAgentSession<TMachine extends AnyStateMachine>(
  machine: TMachine,
  options: RunAgentOptions<TMachine>,
  lifecycle: { oneShot: boolean },
): AgentActorSession<TMachine> {
  const maxModelCalls = options.maxModelCalls ?? 100;
  let modelCallCount = 0;
  let budgetExceeded = false;
  // Dev-only serialization guard: warn at most once per run when idle context
  // holds values that won't survive snapshot persist/resume (see settleIdle).
  let warnedNonSerializable = false;
  let warnedHeuristicIdle = false;
  const runId = `run_${nextRunAgentTraceId++}`;
  let traceSeq = 0;

  // Version stamping (§ item 2): every settled snapshot carries a plain,
  // enumerable `agentMeta` field so it survives JSON persist/resume, and an
  // incoming snapshot's stamp is checked against this version on resume.
  const machineId = (machine.config as { id?: string }).id ?? machine.id ?? "(machine)";
  // Resolution order: explicit option → the machine's own `version` (XState's
  // standard `createMachine({ version })` prop, `.provide`-surviving) → the
  // structural hash.
  const machineVersion =
    options.machineVersion ??
    (machine as { version?: string }).version ??
    getMachineStructuralHash(machine);
  const agentMeta: AgentRunMeta = { machineId, version: machineVersion };
  const stampAgentMeta = (snapshot: unknown): void => {
    if (snapshot && typeof snapshot === "object") {
      (snapshot as { agentMeta?: unknown }).agentMeta = agentMeta;
    }
  };

  const onTrace = (event: AgentTraceEventPayload<TMachine>) => {
    options.onTrace?.({
      schemaVersion: AGENT_TRACE_SCHEMA_VERSION,
      runId,
      seq: ++traceSeq,
      timestamp: new Date().toISOString(),
      machineId,
      machineVersion,
      ...event,
    } as AgentTraceEvent<TMachine>);
  };

  const consumeModelCall = () => {
    if (budgetExceeded) {
      throw new AgentMaxModelCallsExceededError();
    }
    // Count only calls the budget actually admits, so `usage.modelCalls`
    // reports calls MADE (the rejected attempt never reaches an executor).
    if (modelCallCount + 1 > maxModelCalls) {
      budgetExceeded = true;
      throw new AgentMaxModelCallsExceededError();
    }
    modelCallCount += 1;
  };

  const tokenTotals: Partial<Record<keyof AgentCallUsage, number>> = {};

  // Bridges the session closure's `settled` flag (declared further down, once
  // the actor exists) to the usage delivery below, which is defined before it.
  // Nothing has resolved before the run starts.
  const cycleGate = { isResolved: () => false };

  // Reserved `@agent.usage` delivery — the seam that puts a settled call's
  // tokens in reach of the machine's own context and guards (see
  // AGENT_USAGE_EVENT_TYPE). Opt-in BY CONSTRUCTION: sent only when the live
  // root snapshot DECLARES the reserved type explicitly (machine-level `on`
  // catches every call; a state-scoped one only catches calls made while that
  // state is active). A catch-all `on: { '*': … }` does NOT count as opt-in —
  // see declaresUsageTransition. A machine without an explicit declaration
  // gets no extra transition, no `machine.transition` trace, and no extra
  // event-log entry — existing runs are byte-identical.
  //
  // Root actor only: it is the actor whose external inputs the run journals
  // (see the inspect handler), so delivering here is what makes the folded
  // tokens survive an events-only replay. Usage from a request inside an
  // INVOKED CHILD machine is therefore reported to the root too, attributed by
  // the event's `id`/`src`/`model`.
  //
  // A call that settles AFTER the run's current cycle has resolved is a
  // straggler: its tokens still fold into the run-level aggregate, but the
  // event is DROPPED rather than delivered — identical on both the one-shot
  // and the session (`createAgentActor`) path, so a late arrival can never
  // re-open an already-returned idle result. Dropped stragglers are visible on
  // `onTrace` as `usage.dropped`.
  const deliverUsageEvent = (usage: AgentCallUsage, source: AgentUsageEventSource): void => {
    const actorRef = actorHolder.actorRef;
    if (!actorRef) {
      return;
    }
    const event: AgentUsageEvent = { type: AGENT_USAGE_EVENT_TYPE, ...source, usage };
    const snapshot = actorRef.getSnapshot() as AnyMachineSnapshot;
    if (snapshot?.status !== "active" || !declaresUsageTransition(snapshot)) {
      return;
    }
    if (cycleGate.isResolved()) {
      onTrace({ type: "usage.dropped", event, reason: "settled" });
      return;
    }
    if (!snapshot.can(event as never)) {
      return;
    }
    actorRef.send(event as never);
  };

  // Run-level usage aggregation: every executor-reported per-call usage folds
  // in here (see AgentUsage). Token fields are partial sums — a field stays
  // undefined until some call reports it. Scoped to THIS run only.
  const recordUsage = (usage: AgentCallUsage, source: AgentUsageEventSource = {}) => {
    for (const field of AGENT_USAGE_TOKEN_FIELDS) {
      const value = usage[field];
      if (typeof value === "number" && Number.isFinite(value)) {
        tokenTotals[field] = (tokenTotals[field] ?? 0) + value;
      }
    }
    deliverUsageEvent(usage, source);
  };
  const runUsage = (): AgentUsage => ({ ...tokenTotals, modelCalls: modelCallCount });

  // Dev-only: on idle settle, warn once if the snapshot's context holds values
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
      `runAgent: context holds value(s) that will not survive snapshot ` +
        `persist/resume (JSON round-trip): ${offending.join(", ")}. Persist only ` +
        `JSON-serializable context, or convert these before the run settles.`,
    );
  };

  // §3.2 step 1: bind sources. Conceptually `machine.provide({
  // actors: options.actors })` first, then walk the EFFECTIVE
  // (post-provide) sources (spike S4: chained provides merge).
  const provided = machine.provide({
    actors: options.actors as never,
  }) as TMachine;

  const effectiveSources = provided.sources.actors as Record<string, AnyActorLogic>;

  assertBindable(provided, effectiveSources, {
    hasGenerateText: !!options.executors?.generateText,
    hasDecide: !!options.executors?.decide,
    hasStreamText: !!options.executors?.streamText,
  });

  if (options.getRequests && !options.executors?.generateText && !options.executors?.decide) {
    throw new Error(
      "runAgent: 'getRequests' requires a 'generateText' and/or 'decide' executor — " +
        "the returned requests run through them.",
    );
  }

  const actorHolder: { actorRef: AnyActorRef | undefined } = { actorRef: undefined };
  const runCtx: RunAgentBindContext = {
    generateText: options.executors?.generateText,
    streamText: options.executors?.streamText,
    decide: options.executors?.decide,
    onChunk: options.onChunk,
    onResult: options.onResult,
    onTrace: onTrace as RunAgentBindContext["onTrace"],
    consumeModelCall,
    recordUsage,
    actorHolder,
    runId,
    schemas: getRegisteredAgentExecutionOptions(machine).schemas,
  };

  // §3.2 step 2: wrap every effective TextLogic/DecisionLogic (and the
  // agent.* builtins) with a host-backed executor. Invoked child machines are
  // recursively rebound so their requests inherit the same executors at any
  // depth (see rebindChildMachine). Every other source (plain actors,
  // non-agent logic) passes through untouched.
  // True when unhandled `agent.userInput` invokes are bound as pending
  // placeholders: they wait indefinitely and must not block idle detection.
  let userInputIsPlaceholder = false;

  const wrappedSources: Record<string, AnyActorLogic> = {};
  for (const [key, logic] of Object.entries(effectiveSources)) {
    if (key === USER_INPUT_ACTOR) {
      if (options.userInput) {
        const userInput = options.userInput;
        wrappedSources[key] = createAsyncLogic<string, AgentUserInput>({
          run: async ({ input }) => await userInput(input),
        });
      } else if (isUnboundPlaceholder(logic)) {
        // The blessed HITL placeholder: with no handler, an `agent.userInput`
        // invoke waits forever. Idle detection ignores it, so the run settles
        // `{ status: 'idle', pendingUserInputs, persistedSnapshot }` once no
        // OTHER work is in flight (a sibling parallel region keeps running).
        // Resume with the persisted snapshot plus a `userInput` handler; the
        // restored invoke re-runs against the handler and completes.
        userInputIsPlaceholder = true;
        wrappedSources[key] = createAsyncLogic<string, AgentUserInput>({
          run: () => new Promise<never>(() => {}),
        });
      }
      continue;
    }

    if (isDecisionLogic(logic)) {
      wrappedSources[key] = createRunAgentDecisionLogic(logic, runCtx);
      continue;
    }

    if (isTextLogic(logic)) {
      // A text logic that already carries its own executor (`.withExecutor`)
      // runs itself — leave it untouched. Only unbound builtins/logics get a
      // host-backed executor from runAgent's `generateText`/`streamText`.
      if (!executorBoundLogics.has(logic as object)) {
        wrappedSources[key] = wrapTextLogicForRunAgent(logic, runCtx);
      }
      continue;
    }

    if (isStateMachine(logic)) {
      // An invoked child machine (string-keyed): recursively rebind its own
      // agent sources with the same host-backed wrappers, so requests at any
      // depth inherit runAgent's executors. Skipped if nothing needed wrapping.
      const rebound = rebindChildMachine(logic, runCtx, new Set<AnyStateMachine>([machine]));
      if (rebound !== logic) {
        wrappedSources[key] = rebound;
      }
      continue;
    }
    // Non-agent actors and already-unreachable placeholders pass through
    // untouched — assertBindable already rejected reachable placeholders.
  }

  const boundMachine = provided.provide({
    actors: wrappedSources as never,
  }) as TMachine;

  // Resolution order: host override → machine-carried predicate
  // (`setupAgent({ isSuspended })`, read off the original machine so it survives
  // the provide/rebind above) → the timing heuristic (`() => false` here — the
  // inspect handler falls through to `scheduleIdleCheck`).
  const declaredSuspensionPredicate = options.isSuspended ?? getMachineSuspensionPredicate(machine);
  const isSuspended = declaredSuspensionPredicate ?? (() => false);

  // Version stamping (§ item 2): when resuming, compare the incoming snapshot's
  // stamped version against this machine's. A mismatch runs `migrateSnapshot`
  // (its return value is used) if provided, else `onVersionMismatch`
  // ('throw' | 'warn' | 'ignore'). An unstamped snapshot (no `agentMeta` and no
  // XState persisted `version` field) is always accepted. The (possibly
  // migrated) snapshot is threaded through the illegal-resume check,
  // createActor, and the run.start trace. runAgent owns the whole version
  // policy: after this gate, the snapshot's XState-level `version` field is
  // aligned to the machine's (see below) so `restoreSnapshot`'s own
  // mismatch throw never double-fires.
  let effectiveSnapshot = options.snapshot;
  if (effectiveSnapshot !== undefined) {
    const incoming = (effectiveSnapshot as { agentMeta?: { version?: string } }).agentMeta;
    const from = incoming?.version ?? (effectiveSnapshot as { version?: string }).version;
    if (from !== undefined && from !== machineVersion) {
      const info = { from, to: machineVersion };
      if (options.migrateSnapshot) {
        effectiveSnapshot = options.migrateSnapshot(effectiveSnapshot, info);
      } else {
        const mode = options.onVersionMismatch ?? "throw";
        if (mode === "throw") {
          throw new AgentSnapshotVersionMismatchError(from, machineVersion, machineId);
        }
        if (mode === "warn") {
          console.warn(
            `runAgent: resuming a snapshot stamped with machine version '${from}' against ` +
              `machine '${machineId}' at version '${machineVersion}'. Structural changes may ` +
              `not resume cleanly.`,
          );
        }
        // 'ignore': proceed silently.
      }
    }
  }

  // Events-only resume: no `snapshot`, but a self-contained replayable log (a
  // reserved `@agent.init` first entry). Derive the resume snapshot by folding
  // the log through `replay` — recorded model/tool results are never
  // re-executed — then convert the pure-transition snapshot to persisted form
  // so `createActor` restores it (children included). A request that was still
  // in flight when the log ended round-trips as a pending child and re-executes
  // idempotently on restore (XState restarts restored pending async logic), so
  // a crashed run resumes from its log alone. `replay` validates entry
  // contiguity and machine identity/version itself.
  //
  // `@agent.usage` entries are SPEND RECORDS: the tokens were burned at call
  // time, so a crash that lost the call's result does not un-spend them. Every
  // usage entry in the log folds in as-is, and a re-executed call journals its
  // own usage on top — the recovered total is the true cumulative cost.
  const resumeEvents = options.events;
  if (
    effectiveSnapshot === undefined &&
    options.events !== undefined &&
    options.events[0]?.event.type === AGENT_INIT_EVENT_TYPE
  ) {
    const { snapshot: replayedSnapshot } = replay(machine, resumeEvents!, { machineVersion });
    effectiveSnapshot = machine.getPersistedSnapshot(
      replayedSnapshot as never,
    ) as Snapshot<unknown>;
  }

  // Align the snapshot's XState-level `version` field with the machine's own
  // `version` before restore. The gate above already decided compatibility
  // (throw/warn/ignore/migrate), so `restoreSnapshot`'s built-in mismatch
  // throw must not second-guess it — a live `result.snapshot` (or its JSON
  // round-trip) carries no `version` field at all, and would otherwise fail to
  // restore under any versioned machine. Prototype-preserving copy: the
  // caller's snapshot object is never mutated.
  const machineOwnVersion = (machine as { version?: string }).version;
  if (
    effectiveSnapshot !== undefined &&
    (effectiveSnapshot as { version?: string }).version !== machineOwnVersion
  ) {
    const aligned = Object.assign(
      Object.create(Object.getPrototypeOf(effectiveSnapshot) as object | null),
      effectiveSnapshot,
    ) as Snapshot<unknown> & { version?: string };
    if (machineOwnVersion === undefined) {
      delete aligned.version;
    } else {
      aligned.version = machineOwnVersion;
    }
    effectiveSnapshot = aligned;
  }

  // State interpretation (see `RunAgentOptions.getRequests`): the run-owned
  // message log — seeded from an explicit `options.messages`, else the resume
  // snapshot's stamped `messages`, else empty — and its stamp, applied to
  // every settled snapshot (like `agentMeta`) so persist/resume round-trips
  // the log with no extra wiring.
  const priorMessages = getAgentMessages(effectiveSnapshot);
  const messages: AgentMessage[] =
    typeof options.messages === "function"
      ? [...options.messages([...priorMessages])]
      : [...priorMessages, ...(options.messages ?? [])];
  const stampMessages = (snapshot: unknown): void => {
    // Stamp when this run uses the log — and also when a resumed snapshot
    // carried one, so a plain invoke-driven resume never silently drops the
    // conversation that round-tripped in (parity with agentMeta).
    if (!options.getRequests && !options.messages && messages.length === 0) {
      return;
    }
    if (snapshot && typeof snapshot === "object") {
      (snapshot as { messages?: AgentMessage[] }).messages = [...messages];
    }
  };

  // Feature B: reject a resume `event` the restored state cannot take. Checked
  // here (before the actor starts, like the bind-time throws) against the
  // type-level legal set of the restored snapshot — a live-but-unstarted actor
  // exposes it via getAcceptedEvents. A guard-rejected-but-type-legal event
  // still appears here, so it is never treated as illegal. Opt out with
  // onIllegalResumeEvent: 'ignore' (the older silent behavior).
  if (
    effectiveSnapshot !== undefined &&
    options.event !== undefined &&
    (options.onIllegalResumeEvent ?? "throw") === "throw"
  ) {
    const restoredSnapshot = createActor(boundMachine, {
      snapshot: effectiveSnapshot,
    } as never).getSnapshot() as AnyMachineSnapshot;
    const acceptedTypes = getAcceptedEvents(restoredSnapshot, { schemas: runCtx.schemas }).map(
      (descriptor) => descriptor.type,
    );
    const eventType = (options.event as { type: string }).type;
    if (!acceptedTypes.includes(eventType)) {
      throw new AgentIllegalResumeEventError(eventType, acceptedTypes);
    }
  }

  const replayEvents: AgentLogEntry[] = [...(resumeEvents ?? [])];
  const replayEventIds = new Set<string>();
  for (let index = 0; index < replayEvents.length; index++) {
    const entry = replayEvents[index]!;
    assertAgentLogEntry(entry);
    if (entry.index !== index) {
      throw new Error(
        `runAgent events must be contiguous from index 0; found entry.index ${entry.index} ` +
          `at position ${index}.`,
      );
    }
    if (entry.machineId !== machineId || entry.machineVersion !== machineVersion) {
      throw new AgentReplayMachineMismatchError(
        entry.id,
        entry.index,
        { machineId, machineVersion },
        { machineId: entry.machineId, machineVersion: entry.machineVersion },
      );
    }
    if (replayEventIds.has(entry.id)) {
      throw new Error(`runAgent events contain duplicate event id '${entry.id}'.`);
    }
    replayEventIds.add(entry.id);
  }
  const hasCompleteReplayHistory =
    replayEvents[0]?.event.type === "@agent.init" ||
    (effectiveSnapshot === undefined && replayEvents.length === 0);
  const appendReplayEvent = (event: EventObject): AgentLogEntry => {
    const entry = createReplayEntry(machine, replayEvents, event, {
      machineVersion,
      verification: hasCompleteReplayHistory,
    });
    if (replayEventIds.has(entry.id)) {
      throw new Error(`runAgent generated duplicate event id '${entry.id}'.`);
    }
    replayEventIds.add(entry.id);
    replayEvents.push(entry);
    options.onEvent?.(entry);
    return entry;
  };
  if (replayEvents.length === 0 && effectiveSnapshot === undefined) {
    const entry = initEntry(machine, options.input, { machineVersion });
    replayEventIds.add(entry.id);
    replayEvents.push(entry);
    options.onEvent?.(entry);
  }

  const session = ((): AgentActorSession<TMachine> => {
    // One cycle = start (or re-opening event) → next quiescence. `settled`
    // gates the current cycle; `finalized` marks a terminal settle (one-shot
    // mode, or done/error/stopped in session mode) after which the actor is
    // stopped and the result is permanent.
    let settled = false;
    let finalized = false;
    // A call settling after the cycle resolved is a straggler (see
    // deliverUsageEvent): dropped identically on both lifecycle paths.
    cycleGate.isResolved = () => settled;
    let lastResult: RunAgentResult<TMachine> | undefined;
    const waiters: Array<(result: RunAgentResult<TMachine>) => void> = [];
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let actor: ReturnType<typeof createActor<TMachine>>;
    // True only during the resumed actor's initial (restore) transition, while
    // an `event` is still pending delivery. The restored state may itself be a
    // suspended/idle snapshot; without this guard, Feature A's immediate settle
    // would fire during `start()` and settle idle BEFORE the resume event is
    // sent. Cleared right before `actor.send(options.event)`.
    let deliveringResumeEvent = options.event !== undefined;

    const settle = (outcome: RunAgentOutcome<TMachine>) => {
      if (settled) {
        return;
      }
      settled = true;
      const result = {
        ...outcome,
        events: [...replayEvents],
        usage: runUsage(),
      } as RunAgentResult<TMachine>;
      if (idleTimer !== undefined) {
        clearTimeout(idleTimer);
      }
      // Stamp the settled snapshot(s) with the machine id + version. A plain
      // enumerable field (snapshots are not frozen), so it survives JSON
      // persist/resume and is read back on the next resume's version check.
      stampAgentMeta(result.snapshot);
      stampMessages(result.snapshot);
      if ("persistedSnapshot" in result) {
        stampAgentMeta(result.persistedSnapshot);
        stampMessages(result.persistedSnapshot);
      }
      onTrace({ type: "run.end", ...outcome } as AgentTraceEventPayload<TMachine>);
      if (lifecycle.oneShot || result.status !== "idle") {
        finalized = true;
        if (options.signal) {
          options.signal.removeEventListener("abort", onAbort);
        }
        actor.stop();
      }
      lastResult = result;
      for (const resolve of waiters.splice(0)) {
        resolve(result);
      }
    };

    const onAbort = () => {
      settle({
        status: "error",
        cause: "aborted",
        error: options.signal?.reason ?? new Error("Aborted"),
        snapshot: actor.getSnapshot(),
      });
    };

    const settleIdle = (current: AnyMachineSnapshot) => {
      // Idle is the moment persistence matters: the caller resumes from this
      // snapshot by JSON round-trip. In dev, walk the context once and warn on
      // any value that would silently corrupt (Date, Map, Set, function,
      // undefined, class instance, circular). Never throws.
      warnNonSerializableContext(current);
      const pendingUserInputs = userInputIsPlaceholder ? collectPendingUserInputs(current) : [];
      settle({
        status: "idle",
        snapshot: current as SnapshotFrom<TMachine>,
        persistedSnapshot: actor.getPersistedSnapshot() as Snapshot<unknown>,
        ...(pendingUserInputs.length > 0 ? { pendingUserInputs } : {}),
      });
    };

    // ─── State interpretation (RunAgentOptions.getRequests) ───
    // Consulted at every would-be idle settle: if the hook returns request(s)
    // for the current snapshot, run them (model call(s) → message log → one
    // legal event sent each) instead of settling. The pass logic itself is
    // extracted (internal/state-request-pass.ts); what lives HERE is only the
    // glue that must close over this run's mutable state — the live `actor`,
    // the `settled` flag, the shared log, and the idle scheduler — none of
    // which exist outside this promise executor. `interpreting` blocks a
    // concurrent idle settle while a pass's model calls are in flight.
    let interpreting = false;
    let interpretSeq = 0;

    // Append to the run's message log + notify the live observer (onMessage).
    const appendToLog = (...items: AgentMessage[]): void => {
      messages.push(...items);
      if (options.onMessage) {
        const info: AgentMessageInfo = { runId, machineId, machineVersion };
        for (const item of items) {
          options.onMessage(item, info);
        }
      }
    };

    // The run-level error cause ladder, shared by the interpret settle and
    // the machine-error settle in the inspect handler.
    const runErrorCause = (error: unknown): RunAgentErrorCause =>
      budgetExceeded
        ? "max-model-calls"
        : wrapsDecisionExhausted(error)
          ? "decision-exhausted"
          : "machine";

    const settleInterpretError = (error: unknown) => {
      settle({
        status: "error",
        cause: runErrorCause(error),
        error,
        snapshot: actor.getSnapshot(),
      });
    };

    // The pass itself (text phase → ordered advance phase) lives in
    // internal/state-request-pass.ts, testable against a bare actor. These
    // deps are runAgent's host seams: the live actor, settle awareness, the
    // budgeted/traced executors, and the shared log.
    const passDeps: StateRequestPassDeps = {
      getSnapshot: () => actor.getSnapshot() as AnyMachineSnapshot,
      send: (event) => actor.send(event as never),
      isSettled: () => settled,
      messages,
      appendToLog,
      generateText: runCtx.generateText,
      decide: runCtx.decide ? createCountingDecide(runCtx, undefined) : undefined,
      consumeModelCall,
      recordUsage,
      nextRequestId: () => `interpret_${++interpretSeq}`,
      onTrace,
      onResult: runCtx.onResult,
      schemas: runCtx.schemas,
      signal: options.signal,
    };

    // Returns true when the caller must NOT settle idle: a getRequests pass
    // was started for this snapshot, or one is already in flight.
    const maybeInterpret = (snapshot: AnyMachineSnapshot): boolean => {
      if (!options.getRequests || settled) {
        return false;
      }
      if (interpreting) {
        return true;
      }
      let requested: AgentStateRequest | readonly AgentStateRequest[] | undefined;
      try {
        requested = options.getRequests(snapshot as SnapshotFrom<TMachine>, { messages });
      } catch (error) {
        settleInterpretError(error);
        return true;
      }
      const requests = (Array.isArray(requested) ? requested : requested ? [requested] : []).filter(
        (stateRequest): stateRequest is AgentStateRequest => Boolean(stateRequest),
      );
      if (requests.length === 0) {
        return false;
      }
      interpreting = true;
      void runStateRequestPass(requests, passDeps)
        .then(({ sentAny }) => {
          if (settled || sentAny) {
            return;
          }
          // The whole pass sent no event: settle idle rather than re-running
          // the same requests forever.
          const current = actor.getSnapshot() as AnyMachineSnapshot;
          if (isIdleSnapshot(current, { ignoreUserInputChildren: userInputIsPlaceholder })) {
            settleIdle(current);
          }
        })
        .catch((error) => settleInterpretError(error))
        .finally(() => {
          interpreting = false;
          // A transition observed DURING this pass (e.g. our own send while
          // the machine reads as suspended) saw `interpreting` and skipped
          // both settling and starting a new pass — re-evaluate now so the
          // run always makes progress (settle, or the next pass).
          if (!settled) {
            scheduleIdleCheck();
          }
        });
      return true;
    };

    // Fallback for untagged machines: defer one macrotask so in-flight work
    // that starts synchronously with a transition registers first, then settle
    // idle if the snapshot is at rest. Feature A short-circuits this for
    // detector-positive (suspended) snapshots — see the inspect handler.
    const scheduleIdleCheck = () => {
      if (idleTimer !== undefined) {
        clearTimeout(idleTimer);
      }
      idleTimer = setTimeout(() => {
        idleTimer = undefined;
        if (settled) {
          return;
        }
        const current = actor.getSnapshot() as AnyMachineSnapshot;
        if (isIdleSnapshot(current, { ignoreUserInputChildren: userInputIsPlaceholder })) {
          if (!maybeInterpret(current)) {
            if (
              !declaredSuspensionPredicate &&
              current.status === "active" &&
              !warnedHeuristicIdle &&
              process.env.NODE_ENV !== "production"
            ) {
              warnedHeuristicIdle = true;
              console.warn(
                `[@statelyai/agent] runAgent settled idle via the timing heuristic (no ` +
                  `suspension predicate declared). This is best-effort; for deterministic ` +
                  `idle detection, declare setupAgent({ isSuspended }) or pass ` +
                  `runAgent(machine, { isSuspended }), e.g. (s) => s.hasTag('waiting').`,
              );
            }
            settleIdle(current);
          }
        }
      }, 0);
    };

    actor = createActor(boundMachine, {
      input: options.input as never,
      snapshot: effectiveSnapshot,
      inspect: (event: InspectionEvent) => {
        // System-wide passthrough (children included) before runAgent's own
        // root-transition filtering below. Function or observer, like createActor.
        if (typeof options.inspect === "function") {
          options.inspect(event);
        } else {
          options.inspect?.next?.(event);
        }

        if (
          event.type !== "@xstate.transition" ||
          (event.actorRef as unknown) !== (actor.ref as unknown)
        ) {
          return;
        }
        if (settled) {
          if (finalized) {
            return;
          }
          // Session mode: an external event after an idle settle re-opens the
          // cycle. The journal keeps appending to the same log below, and the
          // next quiescence resolves the next `settled()` call.
          settled = false;
          lastResult = undefined;
        }

        const snapshot = event.snapshot as AnyMachineSnapshot;

        // The replay journal is deliberately smaller than the trace. A root
        // transition is an external input when it came from outside the root
        // actor (a host/user send or child completion). Timer delivery is the
        // one self-sent input that must be retained. Initial and raised/internal
        // events are re-derived by initialTransition/transition during replay.
        let eventId: string | undefined;
        if (
          event.event.type !== "@xstate.init" &&
          (event.sourceRef !== event.actorRef || event.event.type === "xstate.timer")
        ) {
          eventId = appendReplayEvent(event.event as EventObject).id;
        } else if (event.event.type === "@xstate.init") {
          eventId = replayEvents[0]?.event.type === "@agent.init" ? replayEvents[0].id : undefined;
        }

        onTrace({
          type: "machine.transition",
          snapshot: snapshot as SnapshotFrom<TMachine>,
          event: event.event as EventFromLogic<TMachine>,
          ...(eventId !== undefined ? { eventId } : {}),
        });

        options.onTransition?.(
          snapshot as SnapshotFrom<TMachine>,
          event.event as EventFromLogic<TMachine>,
        );

        if (snapshot.status === "done") {
          settle({
            status: "done",
            output: snapshot.output as OutputFrom<TMachine>,
            snapshot: snapshot as SnapshotFrom<TMachine>,
          });
          return;
        }

        if (snapshot.status === "error") {
          // Reaching an error state means no `onError` transition handled the
          // failure (a handled one transitions away instead of erroring). So a
          // AgentDecisionExhaustedError surfacing here is genuinely unhandled.
          settle({
            status: "error",
            cause: runErrorCause(snapshot.error),
            error: snapshot.error,
            snapshot: snapshot as SnapshotFrom<TMachine>,
          });
          return;
        }

        if (snapshot.status === "stopped") {
          settle({
            status: "error",
            cause: "stopped",
            error: new Error("Actor stopped externally."),
            snapshot: snapshot as SnapshotFrom<TMachine>,
          });
          return;
        }

        // Feature A: an intentional wait (detector-positive) with nothing in
        // flight settles idle immediately and deterministically — no
        // setTimeout race. `deliveringResumeEvent` suppresses this during a
        // resume's restore transition so the pending event is delivered first.
        // Everything else (untagged machines, or a suspended snapshot with
        // sibling work still running) falls through to the timing heuristic.
        if (
          !deliveringResumeEvent &&
          isSuspended(snapshot) &&
          isIdleSnapshot(snapshot, { ignoreUserInputChildren: userInputIsPlaceholder })
        ) {
          // Not settled synchronously: the event that reached this suspended
          // state may have come from an invoked child mid-flush (child →
          // parent, whose handler sendTo's the child back). A sync settle
          // would persist — and, one-shot, stop — the child before its
          // mailbox drains, losing those deliveries. The flush is
          // synchronous, so one microtask is still deterministic.
          queueMicrotask(() => {
            if (settled) {
              return;
            }
            const current = actor.getSnapshot() as AnyMachineSnapshot;
            if (
              isSuspended(current) &&
              isIdleSnapshot(current, { ignoreUserInputChildren: userInputIsPlaceholder })
            ) {
              if (!maybeInterpret(current)) {
                settleIdle(current);
              }
            }
          });
          return;
        }

        scheduleIdleCheck();
      },
    });

    actorHolder.actorRef = actor as unknown as AnyActorRef;

    // Errors are settled via the `inspect` transition stream above (which
    // observes `snapshot.status === 'error'` regardless of subscribers).
    // Without a subscriber that has an `error` handler, xstate reports
    // machine errors as unhandled exceptions (Actor#_error) even though this
    // run already handles them — subscribe with a no-op to suppress that.
    actor.subscribe({ error: () => {} });

    // Emitted-event handlers (`options.on`), registered before start so
    // events emitted during the initial transition are not missed.
    actor.on("*", (event) => {
      onTrace({ type: "emit", event: event as EmittedFrom<TMachine> });
    });
    for (const [type, handler] of Object.entries(options.on ?? {})) {
      if (typeof handler === "function") {
        actor.on(type as never, handler as never);
      }
    }

    const sessionApi: AgentActorSession<TMachine> = {
      actor,
      get events() {
        return replayEvents;
      },
      usage: runUsage,
      settled: () =>
        settled && lastResult !== undefined
          ? Promise.resolve(lastResult)
          : new Promise<RunAgentResult<TMachine>>((resolve) => {
              waiters.push(resolve);
            }),
      stop: () => {
        actor.stop();
      },
    };

    if (options.signal) {
      if (options.signal.aborted) {
        settle({
          status: "error",
          cause: "aborted",
          error: options.signal.reason ?? new Error("Aborted"),
          snapshot: actor.getSnapshot(),
        });
        return sessionApi;
      }
      options.signal.addEventListener("abort", onAbort);
    }

    onTrace({
      type: "run.start",
      ...(options.input !== undefined ? { input: options.input } : {}),
      ...(effectiveSnapshot !== undefined ? { snapshot: effectiveSnapshot } : {}),
      ...(options.event !== undefined ? { event: options.event } : {}),
    });

    actor.start();
    if (options.event) {
      // Restore transition is done; allow the post-event transition to settle.
      deliveringResumeEvent = false;
      actor.send(options.event as never);
    }

    return sessionApi;
  })();
  return session;
}

/**
 * The resolved value of {@link generateResult}: the `done`-narrowed
 * {@link RunAgentResult} — `output` plus run metadata (`snapshot`, replayable
 * `events`, aggregated `usage`), mirroring how the AI SDK's `generateText`
 * resolves `text` alongside its call metadata.
 */
export type GenerateResult<TMachine extends AnyStateMachine> = Extract<
  RunAgentResult<TMachine>,
  { status: "done" }
>;

/**
 * Runs an agent machine to a **final state**, for run-to-done flows where an
 * idle pause is unexpected. Wraps {@link runAgent}:
 *
 * - `done` → resolves with the done result: `result.output` (the machine's
 *   `OutputFrom`) plus metadata — `result.snapshot`, the replayable
 *   `result.events`, and the aggregated `result.usage` — the same shape
 *   `generateText` users expect (`text` + call metadata).
 * - `idle` → throws {@link AgentIdleError} carrying the idle snapshot and the
 *   event types that could resume it.
 * - `error` → throws `result.error` when it is an `Error`; otherwise wraps it
 *   in an `Error` whose `.cause` is the {@link RunAgentErrorCause} and whose
 *   `.error` is the raw thrown value.
 *
 * Use {@link runAgent} directly when idle is an expected outcome you handle
 * (human-in-the-loop, resumable flows); use `generateResult` when the
 * machine is meant to run straight through to a final state.
 */
export async function generateResult<TMachine extends AnyStateMachine>(
  machine: TMachine,
  options: RunAgentOptions<TMachine>,
): Promise<GenerateResult<TMachine>> {
  const result = await runAgent(machine, options);
  if (result.status === "done") {
    return result;
  }
  if (result.status === "idle") {
    const acceptedTypes = getAcceptedEvents(result.snapshot as AnyMachineSnapshot, {
      schemas: getRegisteredAgentExecutionOptions(machine).schemas,
    }).map((descriptor) => descriptor.type);
    throw new AgentIdleError(result.snapshot as AnyMachineSnapshot, acceptedTypes);
  }
  // error
  if (result.error instanceof Error) {
    throw result.error;
  }
  const wrapped = new Error(`generateResult: run failed with cause '${result.cause}'.`);
  (wrapped as { cause?: unknown }).cause = result.cause;
  (wrapped as { error?: unknown }).error = result.error;
  throw wrapped;
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
 * {@link RunAgentOptions.inspect}: it filters the raw inspection stream to
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
 * Only ROOT-actor transitions are traced (matching `runAgent`'s
 * `machine.transition`); child-actor transitions are ignored. Attribute the
 * event via its envelope `runId`.
 *
 * By design this path has NO `run.start`/`run.end` events: `createActor` has no
 * run boundary the way `runAgent` does, so the stream starts at the actor's
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
    // Root actor only (no parent) — matches runAgent's root-transition filter.
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

// True when a snapshot is active but has no in-flight children and no pending eventless/after work — see §3.3 in .scratch/p0-design.md for the approximation this makes. `ignoreUserInputChildren` exempts pending `agent.userInput` placeholder children (they wait for a human indefinitely and must not block an idle settle).
function isIdleSnapshot(
  snapshot: AnyMachineSnapshot,
  { ignoreUserInputChildren }: { ignoreUserInputChildren: boolean },
): boolean {
  if (snapshot.status !== "active") {
    return false;
  }
  const childrenBusy = Object.values(snapshot.children ?? {}).some((child) => {
    const ref = child as AnyActorRef | undefined;
    if (
      ignoreUserInputChildren &&
      (ref as { src?: unknown } | undefined)?.src === USER_INPUT_ACTOR
    ) {
      return false;
    }
    const childSnapshot = ref?.getSnapshot?.();
    if (childSnapshot?.status !== "active") {
      return false;
    }
    // An active child machine that is itself idle (no busy descendants, no
    // pending eventless/after work) is waiting for events, not doing work —
    // e.g. a long-lived agent invoked across substates. It must not block an
    // idle settle. Non-machine children (promises, decide invokes) that are
    // active are always in-flight work.
    if (isMachineSnapshot(childSnapshot)) {
      return !isIdleSnapshot(childSnapshot, { ignoreUserInputChildren });
    }
    return true;
  });
  if (childrenBusy) {
    return false;
  }
  const hasPendingWork = getNextTransitions(snapshot).some(
    (transitionDef) =>
      transitionDef.eventType === "" || transitionDef.eventType.startsWith("xstate.after"),
  );
  return !hasPendingWork;
}

// Gathers the still-active `agent.userInput` placeholder children off an idle snapshot: one {@link PendingUserInput} per pending invoke, with the invoke's resolved input (prompt, metadata) read off the child's own snapshot.
function collectPendingUserInputs(snapshot: AnyMachineSnapshot): PendingUserInput[] {
  const pending: PendingUserInput[] = [];
  for (const [id, child] of Object.entries(snapshot.children ?? {})) {
    const ref = child as (AnyActorRef & { src?: unknown }) | undefined;
    if (ref?.src !== USER_INPUT_ACTOR) {
      continue;
    }
    const childSnapshot = ref.getSnapshot?.() as { status?: unknown; input?: unknown } | undefined;
    if (childSnapshot?.status !== "active") {
      continue;
    }
    pending.push({ id, input: childSnapshot.input as AgentUserInput | undefined });
  }
  return pending;
}
