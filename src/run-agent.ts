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
  type EventFromLogic,
  type InputFrom,
  type InspectionEvent,
  type OutputFrom,
  type Snapshot,
  type SnapshotFrom,
} from "xstate";
import type {
  AgentTools,
  ChosenEvent,
  InferInput,
  StandardSchemaV1,
  WithAgentInputSchema,
} from "./types.js";
import { AgentError } from "./errors.js";
import {
  findNonSerializableContextPaths,
  isStandardSchema,
  resolveMachineVersion,
  validateSchemaSync,
} from "./utils.js";
import { getAcceptedEvents, type AgentSchemas } from "./events.js";
import {
  AGENT_USAGE_TOKEN_FIELDS,
  GENERATE_TEXT_ACTOR,
  getCallUsage,
  isTextLogic,
  normalizeGeneratorResult,
  STREAM_TEXT_ACTOR,
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
  DEFAULT_AGENT_EXECUTORS,
  getMachineIdlePredicate,
  getRegisteredAgentExecutionOptions,
  isUnboundPlaceholder,
  type DefaultExecutorsRegistry,
} from "./internal/registry.js";
import { AGENT_USAGE_EVENT_TYPE, type AgentUsageEvent } from "./usage.js";
import { AGENT_MESSAGES_EVENT_TYPE } from "./messages.js";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

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
 * machine simply takes no transition). Always enforced; there is no opt-out.
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

/** Handler for `agent.userInput` invokes passed as {@link RunAgentOptions.userInput}. Resolves to what the human typed. */
export interface AgentUserInputExecutor {
  (input: AgentUserInput): PromiseLike<string>;
}

/** Typed root-machine transition observer accepted by {@link runAgent}. */
export type AgentTransitionHandler<TMachine extends AnyStateMachine> = (
  snapshot: SnapshotFrom<TMachine>,
  event: EventFromLogic<TMachine>,
) => void;

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

  /**
   * Machine input. Validated against the machine's declared input schema —
   * defaults filled, transforms applied — before it reaches
   * `createActor(machine, { input })`; invalid
   * input throws an {@link AgentError} with code `invalid-machine-input`.
   * Typed as {@link AgentInputFrom}, so fields the schema defaults are optional
   * here. Omit when resuming via `snapshot`.
   */
  input?: AgentInputFrom<TMachine>;

  // resume
  /** A previously-settled run's `result.persist()`, to resume from instead of starting fresh. Pair with `event` to deliver the event that unblocks the resumed idle state. */
  snapshot?: Snapshot<unknown>;
  /** An event to send immediately after starting/resuming the actor (e.g. the human's answer to an idle-state prompt). */
  event?: EventFromLogic<TMachine>;
  // actor sources — sugar for machine.provide({ actors }) before the run
  /** Actor source implementations, merged onto the machine before binding — sugar for `machine.provide({ actors })` ahead of the run. */
  actors?: Record<string, AnyActorLogic>;

  /**
   * Optional human-input handler for `agent.userInput` invokes (CLI prompt,
   * web form, Slack, …). With a handler, input is gathered inline without
   * settling. Without one, an `agent.userInput` invoke becomes a *pending
   * placeholder*: it waits indefinitely, does not block idle detection, and
   * the run settles `{ status: 'idle', pendingUserInputs }` once no other work
   * is in flight — persist with `result.persist()` and resume that snapshot
   * with a `userInput` handler that answers it.
   */
  userInput?: AgentUserInputExecutor;

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
  onResult?: (request: AgentStepRequest, result: { output: unknown; raw: unknown }) => void;
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
 * variant carries the final `snapshot` and a native XState persistence
 * function. The
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
    }
  | {
      status: "error";
      cause: RunAgentErrorCause;
      error: unknown;
      snapshot: SnapshotFrom<TMachine>;
    };

export type RunAgentResult<TMachine extends AnyStateMachine> = RunAgentOutcome<TMachine> & {
  /**
   * Returns XState's persisted snapshot while the run-owned actor is still
   * available, including active child state. Store this value and pass it back
   * as `snapshot` to resume. Persistence, migration, and retries remain XState
   * and host responsibilities.
   */
  persist(): Snapshot<unknown>;
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

let nextRunAgentTraceId = 1;

/**
 * Thrown into the invoke that would have made the call once
 * {@link RunAgentOptions.maxModelCalls} is spent. It reaches the machine
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
      `runAgent exceeded maxModelCalls (${maxModelCalls}). Raise the budget, or handle it ` +
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

    if (isStateMachineLogic(logic)) {
      assertChildMachineBindable(logic, src, stateName, executors, ctx);
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
      if (!executors.decide) {
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
      if (logic.mode === "stream" && !executors.streamText) {
        throw new Error(
          `runAgent: ${where} '${stateName}' invokes streaming text source '${src}' but ` +
            `no 'streamText' executor was provided to runAgent(...).`,
        );
      }
      if (logic.mode !== "stream" && !executors.generateText) {
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
  // runAgent rebinds the child's unbound requests with its own executors. A
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
  /**
   * The single observation dispatch point (see {@link createTraceDispatch}):
   * the shared emission helpers hand it a bare {@link AgentTraceEventPayload}
   * plus the emitting actor's `self` (the invoked async leaf), and it fans out
   * to the trace sink and to the sugar callbacks derived from that payload.
   * `runAgent` ignores `self` and stamps a run-scoped envelope;
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
   * has no run-scoped root actor. `runAgent` ignores it and delivers to the
   * run's root.
   */
  recordUsage?: (
    usage: AgentCallUsage,
    source?: AgentUsageEventSource,
    self?: BoundActorSelf,
  ) => void;
  /** The owning run's id (`run_<n>`), threaded to executors as `info.runId`. Unset off the runAgent path. */
  runId?: string;
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
  /** Envelope-stamping trace sink (run-scoped on the runAgent path, per-root-actor on the provide path). */
  onTrace?: (payload: AgentTraceEventPayload, self?: BoundActorSelf) => void;
  onChunk?: (chunk: string, info: { request: AgentRequest }) => void;
  onResult?: (request: AgentStepRequest, result: { output: unknown; raw: unknown }) => void;
  onTransition?: (
    snapshot: SnapshotFrom<AnyStateMachine>,
    event: EventFromLogic<AnyStateMachine>,
  ) => void;
}

/**
 * Builds the ONE place a trace payload is emitted: it hands the payload to the
 * envelope-stamping trace sink and, from that same payload, invokes the sugar
 * callbacks that are projections of it — {@link RunAgentOptions.onChunk},
 * {@link RunAgentOptions.onResult}, {@link RunAgentOptions.onTransition}. Each
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
        sinks.onResult?.(payload.request, { output: payload.output, raw: payload.raw });
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
  return self?._parent ?? runCtx.actorHolder.actorRef;
}

/**
 * The shared text/stream emission helper: binds a {@link TextLogic} to
 * `runCtx`'s executor and constructs the `request.start` / `stream.chunk` /
 * `request.end` (incl. the lifted `reasoning`) / `request.error` trace payloads.
 * Used by both `runAgent` and `provideExecutors` so the two paths produce
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
      const raw = await executor(requestWithTools as AgentExecutorTextRequest, {
        onChunk: (chunk: string) => {
          runCtx.emitTrace?.({ type: "stream.chunk", request: agentRequest, chunk }, self);
        },
        signal,
        ...(runCtx.runId !== undefined ? { runId: runCtx.runId } : {}),
        ...(id !== "" ? { requestId: id } : {}),
      });
      const output = await normalizeGeneratorResult(raw, id, {
        request,
        onChunk: (chunk: string) => {
          runCtx.emitTrace?.({ type: "stream.chunk", request: agentRequest, chunk }, self);
        },
      });

      const responseMessages = (raw as { messages?: unknown } | null | undefined)?.messages;
      if (Array.isArray(responseMessages) && responseMessages.length > 0) {
        const parent = invokingActorOf(self, runCtx);
        const event = {
          type: AGENT_MESSAGES_EVENT_TYPE,
          request: request.name!,
          actorId: id,
          messages: responseMessages,
        };
        // Transcript retention is explicit machine behavior. An executor may
        // return messages even when this machine intentionally ignores them;
        // only deliver when the current configuration accepts the event.
        if ((parent?.getSnapshot() as AnyMachineSnapshot | undefined)?.can(event)) {
          parent?.send(event);
        }
      }

      // Lift `reasoning` off the raw executor result (structured-output
      // envelope opt-in) onto the request.end trace — never into machine output.
      const rawReasoning = (raw as { reasoning?: unknown } | null | undefined)?.reasoning;
      const reasoning = typeof rawReasoning === "string" ? rawReasoning : undefined;

      // Fold this call's reported tokens into the run-level AgentUsage, and
      // surface them per-call on the request.end trace.
      const usage = getCallUsage(raw);
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
        },
        self,
      );

      return { output };
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
      // `runId` rides on the request like `signal` does: host-injected
      // correlation, never serialized into machine state. It also rides on the
      // `info` second argument, where generateText/streamText carry it.
      const result = await runCtx.decide!(
        runCtx.runId !== undefined ? { ...attemptRequest, runId: runCtx.runId } : attemptRequest,
        {
          ...info,
          ...(runCtx.runId !== undefined ? { runId: runCtx.runId } : {}),
          ...(info?.requestId === undefined && id !== "" ? { requestId: id } : {}),
        },
      );
      const usage = getCallUsage(result);
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

/** The per-root envelope state, minted on first use (runId `run_<n>`, matching runAgent). */
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
 * `createActor`): the same wrappers runAgent installs, MINUS the run-scoped
 * model-call counter. `consumeModelCall` is a no-op (no budget), and
 * `actorHolder.actorRef` is left undefined — the wrappers read the invoking
 * actor off `self._parent`, always present under a live `createActor` tree.
 * `onTrace` (when given) mints a per-root-actor envelope. `schemas` come from
 * the machine's registered `setupAgent` execution options.
 *
 * `recordUsage` has no run-level aggregate to fold into here (there is no
 * run), so it does one thing: deliver the reserved `@agent.usage` event, gated
 * exactly like runAgent's — see {@link deliverUsageEvent}.
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
      deliverUsageEvent(usage, source ?? {}, () => self?._parent);
    },
    actorHolder: { actorRef: undefined },
    schemas: getRegisteredAgentExecutionOptions(machine).schemas,
  };
}

/**
 * The single reserved-`@agent.usage` delivery seam, shared by both bind paths:
 * after a bound call settles with reported usage, send the event to the machine
 * actor `resolveActorRef` names — the run's root actor on the `runAgent` path,
 * the settling request actor's `self._parent` (always the invoking machine
 * under a live `createActor` tree) on the `provideExecutors` path.
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
  usage: AgentCallUsage,
  source: AgentUsageEventSource,
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
  const event: AgentUsageEvent = { type: AGENT_USAGE_EVENT_TYPE, ...source, usage };
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
 * emission helper as `runAgent` ({@link bindTextLogic}), so a bound
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
  return bindDecisionLogic(logic, provideBindContext(machine, executors, options));
}

/**
 * Recursively binds an invoked child state machine for {@link provideExecutors},
 * with the same semantics `runAgent` applies ({@link rebindChildMachine}):
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
      `runAgent: machine input failed validation against the declared input ` +
        `schema: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
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
  /**
   * Optional per-machine bind-context factory. `runAgent` shares ONE run-scoped
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
  return createAgentSession(machine, options).settled();
}

interface AgentRunSession<TMachine extends AnyStateMachine> {
  settled(): Promise<RunAgentResult<TMachine>>;
}

function createAgentSession<TMachine extends AnyStateMachine>(
  machine: TMachine,
  options: RunAgentOptions<TMachine>,
): AgentRunSession<TMachine> {
  const maxModelCalls = options.maxModelCalls ?? 100;
  let modelCallCount = 0;
  let budgetExceeded = false;
  // Dev-only serialization guard: warn at most once per run when idle context
  // holds values that won't survive snapshot persist/resume (see settleIdle).
  let warnedNonSerializable = false;
  const runId = `run_${nextRunAgentTraceId++}`;
  let traceSeq = 0;
  // Validated once, then used everywhere `options.input` would have been: the
  // actor, the replayable init entry, and the `run.start` trace all see the
  // same post-defaults value, so a replay reproduces this run exactly even if a
  // schema default is computed rather than constant.
  const resolvedInput = resolveMachineInput(machine, options.input);

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

  const tokenTotals: Partial<Record<keyof AgentCallUsage, number>> = {};

  // Bridges the session closure's `settled` flag (declared further down, once
  // the actor exists) to the usage delivery below, which is defined before it.
  // Nothing has resolved before the run starts.
  const cycleGate = { isResolved: () => false };

  // Reserved `@agent.usage` delivery — the seam that puts a settled call's
  // tokens in reach of the machine's own context and guards (see
  // AGENT_USAGE_EVENT_TYPE). Opt-in BY CONSTRUCTION: sent only when the live
  // root snapshot DECLARES a transition that receives the reserved type
  // (machine-level `on` catches every call; a state-scoped one only catches
  // calls made while that state is active). A catch-all `on: { '*': … }` DOES
  // receive it, per plain XState wildcard semantics — see
  // declaresUsageTransition. A machine that declares neither gets no extra
  // transition, no `machine.transition` trace, and no extra event-log entry.
  //
  // Root actor only: it is the actor whose external inputs the run journals
  // (see the inspect handler), so delivering here is what makes the folded
  // tokens survive an events-only replay. Usage from a request inside an
  // INVOKED CHILD machine is therefore reported to the root too, attributed by
  // the event's `id`/`src`/`model`.
  //
  // A call that settles AFTER the run has resolved is a
  // straggler: its tokens still fold into the run-level aggregate, but the
  // event is DROPPED rather than delivered, so a late arrival can never
  // affect an already-returned result. Dropped stragglers are visible on
  // `onTrace` as `usage.dropped`.
  //
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
    deliverUsageEvent(
      usage,
      source,
      () => actorHolder.actorRef,
      (event) => {
        if (!cycleGate.isResolved()) {
          return false;
        }
        onTrace({ type: "usage.dropped", event, reason: "settled" });
        return true;
      },
    );
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

  const registeredModels = getRegisteredAgentExecutionOptions(machine).models as
    | DefaultExecutorsRegistry
    | undefined;
  const executors = {
    ...registeredModels?.[DEFAULT_AGENT_EXECUTORS]?.(),
    ...options.executors,
  };

  assertBindable(provided, effectiveSources, executors);

  const actorHolder: { actorRef: AnyActorRef | undefined } = { actorRef: undefined };
  const runCtx: RunAgentBindContext = {
    generateText: executors.generateText,
    streamText: executors.streamText,
    decide: executors.decide,
    emitTrace: onTrace as TraceDispatch,
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
        // `{ status: 'idle', pendingUserInputs }` once no
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
      wrappedSources[key] = bindDecisionLogic(logic, runCtx);
      continue;
    }

    if (isTextLogic(logic)) {
      // A text logic that already carries its own executor (`.withExecutor`)
      // runs itself — leave it untouched. Only unbound builtins/logics get a
      // host-backed executor from runAgent's `generateText`/`streamText`.
      if (!executorBoundLogics.has(logic as object)) {
        wrappedSources[key] = bindTextLogic(logic, runCtx);
      }
      continue;
    }

    if (isStateMachineLogic(logic)) {
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

  // The machine owns its wait semantics. An explicit setupAgent predicate wins;
  // otherwise a resting configuration with event handlers (or interaction
  // metadata) is an intentional external wait.
  const isIdle = getMachineIdlePredicate(machine) ?? isAgentIdle;
  const isIntentionalIdle = (snapshot: AnyMachineSnapshot) =>
    isIdle(snapshot) || collectPendingUserInputs(snapshot).length > 0;

  const effectiveSnapshot = options.snapshot;

  // Feature B: reject a resume `event` the restored state cannot take. Checked
  // here (before the actor starts, like the bind-time throws) against the
  // type-level legal set of the restored snapshot — a live-but-unstarted actor
  // exposes it via getAcceptedEvents. A guard-rejected-but-type-legal event
  // still appears here, so it is never treated as illegal. Always enforced.
  if (effectiveSnapshot !== undefined && options.event !== undefined) {
    const restoredSnapshot = createActor(boundMachine, {
      snapshot: effectiveSnapshot,
    } as never).getSnapshot() as AnyMachineSnapshot;
    if (restoredSnapshot.status === "active") {
      const acceptedTypes = getAcceptedEvents(restoredSnapshot, { schemas: runCtx.schemas }).map(
        (descriptor) => descriptor.type,
      );
      const eventType = (options.event as { type: string }).type;
      if (!acceptedTypes.includes(eventType)) {
        throw new AgentIllegalResumeEventError(eventType, acceptedTypes);
      }
    }
  }

  // One run = start (or resume event) to the next quiescence.
  let settled = false;
  // A call settling after the run resolved is a straggler (see
  // deliverUsageEvent): dropped after the run settles.
  cycleGate.isResolved = () => settled;
  let lastResult: RunAgentResult<TMachine> | undefined;
  const waiters: Array<(result: RunAgentResult<TMachine>) => void> = [];
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let actor: ReturnType<typeof createActor<TMachine>>;
  let actorStarted = false;
  // True only during the resumed actor's initial (restore) transition, while
  // an `event` is still pending delivery. The restored state may itself be a
  // idle snapshot; without this guard, Feature A's immediate settle
  // would fire during `start()` and settle idle BEFORE the resume event is
  // sent. Cleared right before `actor.send(options.event)`.
  let deliveringResumeEvent = options.event !== undefined;

  const settle = (outcome: RunAgentOutcome<TMachine>) => {
    if (settled) {
      return;
    }
    settled = true;
    let persistedSnapshot: Snapshot<unknown> | undefined;
    let persistenceError: unknown;
    if (actorStarted && outcome.status !== "done") {
      try {
        persistedSnapshot = actor.getPersistedSnapshot() as Snapshot<unknown>;
      } catch (error) {
        persistenceError = error;
      }
    }
    const persist = () => {
      if (persistenceError !== undefined) {
        throw persistenceError;
      }
      persistedSnapshot ??= actor.getPersistedSnapshot() as Snapshot<unknown>;
      return persistedSnapshot;
    };
    const result = {
      ...outcome,
      persist,
      usage: runUsage(),
    } as RunAgentResult<TMachine>;
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer);
    }
    onTrace({ type: "run.end", ...outcome } as AgentTraceEventPayload<TMachine>);
    if (options.signal) {
      options.signal.removeEventListener("abort", onAbort);
    }
    actor.stop();
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
      ...(pendingUserInputs.length > 0 ? { pendingUserInputs } : {}),
    });
  };

  // The run-level error cause ladder.
  const runErrorCause = (error: unknown): RunAgentErrorCause =>
    budgetExceeded
      ? "max-model-calls"
      : wrapsDecisionExhausted(error)
        ? "decision-exhausted"
        : "machine";

  // Fallback for untagged machines: defer one macrotask so in-flight work
  // that starts synchronously with a transition registers first, then settle
  // idle if the snapshot is at rest. Feature A short-circuits this for
  // detector-positive (idle) snapshots — see the inspect handler.
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
      if (
        isIntentionalIdle(current) &&
        isIdleSnapshot(current, { ignoreUserInputChildren: userInputIsPlaceholder })
      ) {
        settleIdle(current);
      }
    }, 0);
  };

  actor = createActor(boundMachine, {
    input: resolvedInput as never,
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
        return;
      }

      const snapshot = event.snapshot as AnyMachineSnapshot;

      onTrace({
        type: "machine.transition",
        snapshot: snapshot as SnapshotFrom<TMachine>,
        event: event.event as EventFromLogic<TMachine>,
      });

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
      // Everything else (untagged machines, or a idle snapshot with
      // sibling work still running) falls through to the timing heuristic.
      if (
        !deliveringResumeEvent &&
        isIntentionalIdle(snapshot) &&
        isIdleSnapshot(snapshot, { ignoreUserInputChildren: userInputIsPlaceholder })
      ) {
        // Not settled synchronously: the event that reached this idle
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
            isIntentionalIdle(current) &&
            isIdleSnapshot(current, { ignoreUserInputChildren: userInputIsPlaceholder })
          ) {
            settleIdle(current);
          } else {
            // A drained child event started new work (or left the idle state)
            // without a root transition to re-trigger idle detection — fall
            // back to the timing heuristic so the run still settles.
            scheduleIdleCheck();
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

  const sessionApi: AgentRunSession<TMachine> = {
    settled: () =>
      settled && lastResult !== undefined
        ? Promise.resolve(lastResult)
        : new Promise<RunAgentResult<TMachine>>((resolve) => {
            waiters.push(resolve);
          }),
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
    ...(resolvedInput !== undefined ? { input: resolvedInput as InputFrom<TMachine> } : {}),
    ...(effectiveSnapshot !== undefined ? { snapshot: effectiveSnapshot } : {}),
    ...(options.event !== undefined ? { event: options.event } : {}),
  });

  actorStarted = true;
  actor.start();
  // Restoring an incompatible native XState snapshot can synchronously leave
  // the actor in an error/stopped state without emitting an inspection event.
  // Observe that post-start snapshot directly so the run cannot hang (or try
  // to deliver a resume event to an actor XState has already stopped).
  if (!settled) {
    const startedSnapshot = actor.getSnapshot() as AnyMachineSnapshot;
    if (startedSnapshot.status === "done") {
      settle({
        status: "done",
        output: startedSnapshot.output as OutputFrom<TMachine>,
        snapshot: startedSnapshot as SnapshotFrom<TMachine>,
      });
    } else if (startedSnapshot.status === "error") {
      settle({
        status: "error",
        cause: runErrorCause(startedSnapshot.error),
        error: startedSnapshot.error,
        snapshot: startedSnapshot as SnapshotFrom<TMachine>,
      });
    } else if (startedSnapshot.status === "stopped") {
      settle({
        status: "error",
        cause: "stopped",
        error: new Error("Actor stopped externally."),
        snapshot: startedSnapshot as SnapshotFrom<TMachine>,
      });
    }
  }
  if (options.event && !settled) {
    // Restore transition is done; allow the post-event transition to settle.
    deliveringResumeEvent = false;
    actor.send(options.event as never);
  }

  return sessionApi;
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

/**
 * Default machine-owned idle signal used by {@link runAgent}: an active
 * snapshot that accepts an external event anywhere in its active hierarchy,
 * or declares interaction metadata on an active state.
 *
 * Compose this in `setupAgent({ isIdle })` when the application has additional
 * wait states: `isIdle: (snapshot) => isAgentIdle(snapshot) || snapshot.hasTag('waiting')`.
 * Pending work and active invoked children are checked separately by the
 * runner, so this function only answers whether the state is an intentional
 * external wait.
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
