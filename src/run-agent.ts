import {
  createActor,
  createAsyncLogic,
  getNextTransitions,
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
import type { AgentTools, ChosenEvent } from "./types.js";
import { findNonSerializableContextPaths, getMachineStructuralHash } from "./utils.js";
import { getAcceptedEvents, sanitizeEventToolName, type AgentSchemas } from "./events.js";
import {
  isTextLogic,
  normalizeGeneratorResult,
  USER_INPUT_ACTOR,
  type AgentRequestExecutor,
  type AgentRequestExecutors,
  type AgentTextRequest,
  type AgentUserInput,
  type TextLogic,
} from "./text-logic.js";
import {
  advancePlanLedger,
  DecisionExhaustedError,
  initialPlanLedger,
  isDecisionLogic,
  isPlanLogic,
  PLAN_DONE_EVENT_TYPE,
  resolveDecision,
  type AgentDecisionExecutor,
  type AgentDecisionRequest,
  type AgentPlanInput,
  type AgentPlanOutput,
  type DecisionLogic,
  type PlanLogic,
} from "./decision.js";
import type { AgentRequest, AgentStepRequest } from "./steps.js";
import {
  executorBoundLogics,
  getMachineSuspensionPredicate,
  getRegisteredAgentExecutionOptions,
  isUnboundPlaceholder,
} from "./internal/registry.js";

// ─── runAgent (createActor wrapper) ───
//
// See docs/p0-design.md §3. Unlike the step helpers above (a pure
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
export class IllegalResumeEventError extends Error {
  readonly eventType: string;
  readonly acceptedTypes: string[];
  constructor(eventType: string, acceptedTypes: string[]) {
    super(
      `runAgent: cannot resume with event '${eventType}' — the restored state does not accept ` +
        `it. Accepted event types: ${acceptedTypes.length > 0 ? acceptedTypes.join(", ") : "(none)"}.`,
    );
    this.name = "IllegalResumeEventError";
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
export class SnapshotVersionMismatchError extends Error {
  readonly from: string;
  readonly to: string;
  readonly machineId: string;
  constructor(from: string, to: string, machineId: string) {
    super(
      `runAgent: cannot resume snapshot stamped with machine version '${from}' against ` +
        `machine '${machineId}' at version '${to}' — the machine's structure changed since ` +
        `the snapshot was persisted. Provide options.migrateSnapshot to adapt it, or set ` +
        `options.onVersionMismatch to 'warn'/'ignore' to proceed anyway.`,
    );
    this.name = "SnapshotVersionMismatchError";
    this.from = from;
    this.to = to;
    this.machineId = machineId;
  }
}

/**
 * Thrown by {@link runAgentToCompletion} when the run settles `idle` instead of
 * `done`: the machine paused for external input. Carries the idle `snapshot`
 * and `acceptedTypes` (the event types that could resume it, via
 * {@link getAcceptedEvents}). Use {@link runAgent} directly when idle is an
 * expected outcome you handle.
 */
export class AgentIdleError extends Error {
  readonly snapshot: AnyMachineSnapshot;
  readonly acceptedTypes: string[];
  constructor(snapshot: AnyMachineSnapshot, acceptedTypes: string[]) {
    super(
      `runAgentToCompletion: the machine paused (idle) instead of completing. Resume it by ` +
        `calling runAgent with one of these events: ${
          acceptedTypes.length > 0 ? acceptedTypes.join(", ") : "(none)"
        }.`,
    );
    this.name = "AgentIdleError";
    this.snapshot = snapshot;
    this.acceptedTypes = acceptedTypes;
  }
}

/** Handler for `agent.userInput` invokes passed as {@link RunAgentOptions.userInput}. */
export interface AgentUserInputExecutor {
  (input: AgentUserInput): PromiseLike<unknown>;
}

export type AgentTraceEvent<TMachine extends AnyStateMachine = AnyStateMachine> = {
  runId: string;
  seq: number;
  timestamp: string;
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
    }
  | { type: "request.error"; request: AgentStepRequest; error: unknown }
  | { type: "stream.chunk"; request: AgentRequest; chunk: string }
  | {
      type: "machine.transition";
      snapshot: SnapshotFrom<TMachine>;
      event: EventFromLogic<TMachine>;
    }
  | { type: "emit"; event: EmittedFrom<TMachine> }
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

type AgentTraceEventPayload<TMachine extends AnyStateMachine = AnyStateMachine> =
  AgentTraceEvent<TMachine> extends infer TEvent
    ? TEvent extends unknown
      ? Omit<TEvent, "runId" | "seq" | "timestamp">
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
   * How to handle a resume `event` the restored state cannot accept (a
   * type-level check via {@link getAcceptedEvents}, only applied when resuming
   * from a `snapshot`). `'throw'` (default) throws {@link IllegalResumeEventError}
   * before delivering the event; `'ignore'` restores the older silent behavior
   * (the event is sent and the machine drops it). A type-legal event a guard
   * rejects is never an illegal resume event.
   */
  onIllegalResumeEvent?: "throw" | "ignore";

  // version stamping
  /**
   * The version stamped onto every settled snapshot's `agentMeta` and compared
   * against an incoming snapshot's stamp on resume. Defaults to
   * {@link getMachineStructuralHash} of the machine (a structural fingerprint).
   * Set an explicit value (e.g. a semver or build id) to control migration
   * boundaries yourself.
   */
  machineVersion?: string;
  /**
   * How to handle a resume `snapshot` whose stamped `agentMeta.version` differs
   * from the current machine's version. `'throw'` (default) throws
   * {@link SnapshotVersionMismatchError} with `from`/`to`; `'warn'`
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

  // implementations — sugar for machine.provide({ actorSources }) before the run
  /** Actor source implementations, merged onto the machine before binding — sugar for `machine.provide({ actorSources })` ahead of the run. */
  actorSources?: Record<string, AnyActorLogic>;

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
   * predicate returns true and nothing is in flight (no live requests/plans/
   * invokes; the `agent.userInput` placeholder exemption still applies), runAgent
   * settles idle immediately, without the `setTimeout` heuristic. It does NOT
   * force-settle while agent work is in flight, and whole-machine idle semantics
   * are unchanged; a machine with no predicate falls back to the heuristic
   * exactly as before. Declare your own signal, e.g.
   * `(s) => s.hasTag('awaiting-review')`.
   *
   * Provisional name — may change before 2.0.
   */
  isSuspended?: (snapshot: AnyMachineSnapshot) => boolean;

  // observation — all void; no callback controls the run
  /** Fires for each streamed chunk of a `mode: 'stream'` text request, alongside the {@link AgentRequest} that produced it (parallel states can interleave multiple streams). Purely observational. */
  onChunk?: (chunk: string, info: { request: AgentRequest }) => void;
  /** Fires once per resolved text/decision request with its normalized output and the raw executor result (tool calls, usage, …) — the seam for tracing/observability and event-sourced replay logging. */
  onResult?: (request: AgentStepRequest, result: { output: unknown; raw: unknown }) => void;
  /** Fires a single ordered stream of run/request/chunk/transition/emit/end events. Intended for eval traces, JSONL logs, and adapter-owned telemetry/exporters. */
  onTrace?: (event: AgentTraceEvent<TMachine>) => void;
  /**
   * Fires on every machine transition (snapshot + causing event). Pure
   * observation — progress UIs, logging, tracing. Cannot send events.
   */
  onTransition?: (snapshot: SnapshotFrom<TMachine>, event: EventFromLogic<TMachine>) => void;
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
   */
  inspect?: (inspectionEvent: InspectionEvent) => void;

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
 * variant carries the final `snapshot`, and the underlying
 * actor is stopped on every settle path — there is no live actor to resume;
 * resume is always by snapshot.
 */
/** A pending unhandled `agent.userInput` invoke surfaced on an idle settle — `id` is the invoke's id, `input` its resolved invoke input (prompt, schema, …). Answer it by resuming with a `userInput` handler. */
export interface PendingUserInput {
  id: string;
  input: AgentUserInput | undefined;
}

export type RunAgentResult<TMachine extends AnyStateMachine> =
  | { status: "done"; output: OutputFrom<TMachine>; snapshot: SnapshotFrom<TMachine> }
  | {
      status: "idle";
      snapshot: SnapshotFrom<TMachine>;
      /** Present when the machine is waiting on unhandled `agent.userInput` invokes: one entry per pending invoke. */
      pendingUserInputs?: PendingUserInput[];
      /**
       * Present alongside `pendingUserInputs`: the JSON-serializable persisted
       * snapshot (in-flight children included). Persist THIS one and resume
       * with `runAgent(machine, { snapshot: persistedSnapshot, userInput })` —
       * the live `snapshot` above cannot round-trip active children.
       */
      persistedSnapshot?: Snapshot<unknown>;
    }
  | {
      status: "error";
      cause: RunAgentErrorCause;
      error: unknown;
      snapshot: SnapshotFrom<TMachine>;
    };

/**
 * Discriminates a {@link RunAgentResult} `error`:
 * - `'aborted'` — the run's `signal` fired.
 * - `'max-model-calls'` — the `maxModelCalls` budget was exceeded.
 * - `'decision-exhausted'` — the machine reached an error state whose error is
 *   (or wraps) a {@link DecisionExhaustedError} that no `onError` handled.
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

class MaxModelCallsExceededError extends Error {
  constructor() {
    super("runAgent exceeded maxModelCalls.");
    this.name = "MaxModelCallsExceededError";
  }
}

// True when `error` is a DecisionExhaustedError or wraps one via its `cause`
// chain (an onError re-throw, or a machine error that carries the original as
// its cause). Bounded so a cyclic cause chain can't loop forever.
function wrapsDecisionExhausted(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 10 && current != null; depth++) {
    if (current instanceof DecisionExhaustedError) {
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
 * a `.provide(...)` method plus an `implementations.actorSources` map — this
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
    typeof (logic as { implementations?: unknown }).implementations === "object" &&
    !!(logic as { implementations?: { actorSources?: unknown } }).implementations?.actorSources
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
      if (
        (isTextLogic(src) || isDecisionLogic(src) || isPlanLogic(src)) &&
        !executorBoundLogics.has(src as object)
      ) {
        throw new Error(
          `runAgent: ${where} '${stateName}' invokes a direct-object actor logic ` +
            `(kind: '${(src as TextLogic | DecisionLogic).kind}'). Direct-object invoke ` +
            `srcs cannot be rebound by runAgent — either call '.withExecutor(...)' on ` +
            `the logic before invoking it, or register it as a string-keyed actor ` +
            `source instead (machine.provide({ actorSources: { name: logic } })) and ` +
            `invoke it by name.`,
        );
      }
      continue;
    }

    const logic = effectiveSources[src];

    if (logic === undefined) {
      throw new Error(
        `runAgent: ${where} '${stateName}' invokes unregistered actor source '${src}'. ` +
          `Provide it via machine.provide({ actorSources: { '${src}': ... } }) or ` +
          `runAgent(machine, { actorSources: { '${src}': ... } }).`,
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

    if (isPlanLogic(logic)) {
      // Plans resolve steps through the same `decide` executor.
      if (!ctx.rebindable) {
        throw unrebindableChildRequestError(ctx.childPath, stateName, src, "plan");
      }
      if (!options.hasDecide) {
        throw new Error(
          `runAgent: ${where} '${stateName}' invokes plan source '${src}' but no ` +
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
          `host execution. Provide it via machine.provide({ actorSources: { '${src}': ... } }) ` +
          `or runAgent(machine, { actorSources: { '${src}': ... } }).`,
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

  const childSources = childMachine.implementations.actorSources as Record<string, AnyActorLogic>;

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
  kind: "text" | "streaming text" | "decision" | "plan",
): Error {
  return new Error(
    `runAgent: child machine '${childPath}' (state '${stateName}') invokes ${kind} ` +
      `source '${requestSrc}', which has no host execution and is reached through a ` +
      `direct-object invoke src that runAgent cannot rebind. Requests reached through ` +
      `string-keyed actor sources inherit runAgent's generateText/streamText/decide ` +
      `executors automatically; a direct-object child machine does not. Either bind the ` +
      `request with its own executor (requestLogic.withExecutor(...)), or register the ` +
      `child as a string-keyed actor source (machine.provide({ actorSources: { <child>: ` +
      `childMachine } })) and invoke it by name.`,
  );
}

// Shared state closed over by every wrapped actor source in one runAgent call: executors, observation callbacks, and the shared model-call budget/actor ref.
interface RunAgentBindContext {
  generateText?: AgentRequestExecutor;
  streamText?: AgentRequestExecutor;
  decide?: AgentDecisionExecutor;
  onChunk?: (chunk: string, info: { request: AgentRequest }) => void;
  onResult?: (request: AgentStepRequest, result: { output: unknown; raw: unknown }) => void;
  onTrace?: (event: AgentTraceEventPayload) => void;
  consumeModelCall: () => void;
  /** Assigned right after createActor (§2.6); read lazily by decision wraps. */
  actorHolder: { actorRef: AnyActorRef | undefined };
  /** Registered `setupAgent` schemas (for event `inputSchema`s), if any. */
  schemas?: AgentSchemas;
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
 * The machine actor that INVOKED a decision/plan request — the actor whose
 * live snapshot supplies the candidate events and drives `canTake`/`send`.
 * For a top-level request this is the root actor (identity-equal to
 * `runCtx.actorHolder.actorRef`); for a request inside an invoked child
 * machine it is that child's actor, so a child decision/plan reads and drives
 * the CHILD's snapshot — not the root's. Read off `self._parent`, with the
 * root actor as a fallback.
 */
function invokingActorOf(self: unknown, runCtx: RunAgentBindContext): AnyActorRef | undefined {
  const parent = (self as { _parent?: AnyActorRef } | undefined)?._parent;
  return parent ?? runCtx.actorHolder.actorRef;
}

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
    runCtx.onTrace?.({ type: "request.start", request: agentRequest });
    try {
      const raw = await executor(requestWithTools, {
        onChunk: (chunk: string) => {
          runCtx.onTrace?.({ type: "stream.chunk", request: agentRequest, chunk });
          runCtx.onChunk?.(chunk, { request: agentRequest });
        },
        signal,
      });
      const output = await normalizeGeneratorResult(raw, id, {
        request,
        onChunk: (chunk: string) => {
          runCtx.onTrace?.({ type: "stream.chunk", request: agentRequest, chunk });
          runCtx.onChunk?.(chunk, { request: agentRequest });
        },
      });

      // Lift `reasoning` off the raw executor result (structured-output
      // envelope opt-in) onto the request.end trace — never into machine output.
      const rawReasoning = (raw as { reasoning?: unknown } | null | undefined)?.reasoning;
      const reasoning = typeof rawReasoning === "string" ? rawReasoning : undefined;

      runCtx.onResult?.(agentRequest, { output, raw });
      runCtx.onTrace?.({
        type: "request.end",
        request: agentRequest,
        output,
        raw,
        ...(reasoning !== undefined ? { reasoning } : {}),
      });

      return { output };
    } catch (error) {
      runCtx.onTrace?.({ type: "request.error", request: agentRequest, error });
      throw error;
    }
  });
}

// Wraps runCtx's `decide` executor with model-call budgeting and tracing —
// shared by the decision and plan wrappers.
function createCountingDecide(runCtx: RunAgentBindContext): AgentDecisionExecutor {
  return async (attemptRequest) => {
    runCtx.consumeModelCall();
    runCtx.onTrace?.({ type: "request.start", request: attemptRequest });
    try {
      const result = await runCtx.decide!(attemptRequest);
      runCtx.onResult?.(attemptRequest, { output: result.event, raw: result });
      runCtx.onTrace?.({
        type: "request.end",
        request: attemptRequest,
        output: result.event,
        raw: result,
      });
      return result;
    } catch (error) {
      runCtx.onTrace?.({ type: "request.error", request: attemptRequest, error });
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
 * On success it SENDS the chosen event to the invoking actor (auto-delivery,
 * mirroring {@link createRunAgentPlanLogic}) and then completes with that event
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

      const chosen = await resolveDecision(request, createCountingDecide(runCtx), {
        maxRetries: logic.maxRetries,
        signal,
        canTake: (event) =>
          actorRef ? (actorRef.getSnapshot() as AnyMachineSnapshot).can(event) : true,
      });

      // Auto-deliver (mirrors createRunAgentPlanLogic): send the chosen event
      // to the invoking actor, then complete with it as output. The delivered
      // event's transition typically EXITS the invoking state, which cancels
      // this invoke — so `onDone` never fires on that path (same semantics as a
      // plan whose applied event exits the state). If the transition stays
      // in-state instead, the invoke completes and `onDone` (if any) observes
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
 * Builds the plan actor logic runAgent installs in place of the `agent.plan`
 * builtin: iterated {@link resolveDecision}. Each step re-reads the live
 * snapshot (so the candidate set reflects everything applied so far), asks
 * the `decide` executor for one legal event with the same validation/retry
 * loop a decision gets, and sends it to the machine. The loop ends on a
 * `stopOn` event, at `maxSteps`, when no legal candidate remains, or when an
 * applied event exits the invoking state (xstate cancels this invoke — the
 * machine simply moves on and the pending output is discarded).
 *
 * The invoke's `input` is resolved once, so the prompt cannot re-render
 * context between steps; instead the applied trail is appended to the prompt
 * each step so the model can see plan progress.
 */
function createRunAgentPlanLogic(logic: PlanLogic, runCtx: RunAgentBindContext): PlanLogic {
  const planLogic = createAsyncLogic<AgentPlanOutput, AgentPlanInput>({
    run: async ({ input, signal, self }) => {
      if (!runCtx.decide) {
        throw new Error("runAgent: no 'decide' executor provided.");
      }
      const { id } = selfIdAndSrc(self);
      const stopOn = new Set<string>(input.stopOn ?? []);
      const countingDecide = createCountingDecide(runCtx);
      const base = logic.request(input);

      // All bookkeeping (applied trail + remaining budget) rides the shared
      // plan ledger — the SAME driver the step path uses on the invoke child's
      // own snapshot. Here it is a local ledger the host advances by hand.
      let ledger = initialPlanLedger(logic, input);
      const end = (stopped: AgentPlanOutput["stopped"]): AgentPlanOutput => {
        ledger = advancePlanLedger(logic, ledger, { type: "plan.ended", stopped });
        return ledger.output as AgentPlanOutput;
      };

      // Same microtask yield as the decision wrapper: let the invoking
      // transition commit before the first snapshot read.
      await Promise.resolve();

      // The invoking machine actor (child at any depth, else root) — its
      // snapshot drives candidates/canTake, and each chosen event is sent to
      // it, so a plan inside a child machine drives the CHILD.
      const invokingActor = invokingActorOf(self, runCtx);

      while (ledger.context.stepsRemaining > 0) {
        const actorRef = invokingActor;
        if (!actorRef || signal.aborted) {
          break;
        }
        const snapshot = actorRef.getSnapshot() as AnyMachineSnapshot;
        const machineEvents = getAcceptedEvents(snapshot, {
          schemas: runCtx.schemas,
          eventTypes: logic.allowedEventTypes(input),
        });
        if (machineEvents.length === 0) {
          return end("no-legal-events");
        }
        // Every step also offers the built-in "done" move: an explicit "no
        // further action needed" the model can choose instead of being forced
        // to pick some machine event. Never sent to the machine.
        const doneDescriptor = {
          type: PLAN_DONE_EVENT_TYPE,
          toolName: sanitizeEventToolName(PLAN_DONE_EVENT_TYPE),
        };
        const events = machineEvents.some((event) => event.type === PLAN_DONE_EVENT_TYPE)
          ? machineEvents
          : [...machineEvents, doneDescriptor];

        const applied = ledger.context.applied;
        const trail =
          applied.length === 0
            ? ""
            : `\n\nEvents already applied in this plan, in order:\n${applied
                .map((step) => JSON.stringify(step))
                .join("\n")}\nContinue from here; do not repeat applied events.`;
        const doneHint = `\n\nWhen the request is fully handled (or no action is needed), choose '${PLAN_DONE_EVENT_TYPE}'.`;
        const request: AgentDecisionRequest = {
          ...base,
          id: `${id}[${applied.length}]`,
          events,
          prompt: `${base.prompt ?? ""}${trail}${doneHint}`,
          attempts: [],
        };

        const chosen = await resolveDecision(request, countingDecide, {
          maxRetries: input.maxRetries ?? logic.maxRetries,
          signal,
          canTake: (event) => {
            // The built-in done move and stopOn events terminate the plan
            // rather than driving a transition — a pure no-op handler
            // (`NOTHING: {}`) makes `snapshot.can(...)` false, so exempt
            // both from the guard check.
            if (event.type === PLAN_DONE_EVENT_TYPE || stopOn.has(event.type)) {
              return true;
            }
            return invokingActor
              ? (invokingActor.getSnapshot() as AnyMachineSnapshot).can(event)
              : true;
          },
        });

        if (chosen.type === PLAN_DONE_EVENT_TYPE) {
          return end("done");
        }

        actorRef.send(chosen as never);
        ledger = advancePlanLedger(logic, ledger, { type: "plan.applied", event: chosen });
        // Let the applied transition commit before the next snapshot read
        // (and let xstate cancel this invoke if the event exited the state).
        await Promise.resolve();

        if (stopOn.has(chosen.type)) {
          return end("stop-event");
        }
      }

      return end("max-steps");
    },
  });

  // runAgent owns async: the invoke child is this async wrapper, not the
  // createLogic ledger (the ledger is internal bookkeeping). The `kind` marker
  // is what isPlanLogic keys on; the transition-shape mismatch is expected.
  return Object.assign(planLogic, {
    kind: "statelyai.planLogic" as const,
    maxRetries: logic.maxRetries,
    request: logic.request,
    allowedEventTypes: logic.allowedEventTypes,
  }) as unknown as PlanLogic;
}

/**
 * Recursively rebinds an invoked child machine's own agent sources with the
 * SAME host-backed wrappers runAgent applies to the top-level machine, so a
 * child's text/stream/decision/plan requests inherit runAgent's executors and
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
  const sources = childMachine.implementations.actorSources as Record<string, AnyActorLogic>;
  const wrapped: Record<string, AnyActorLogic> = {};

  for (const [key, logic] of Object.entries(sources)) {
    if (isDecisionLogic(logic)) {
      if (!executorBoundLogics.has(logic as object)) {
        wrapped[key] = createRunAgentDecisionLogic(logic, runCtx);
      }
      continue;
    }
    if (isPlanLogic(logic)) {
      wrapped[key] = createRunAgentPlanLogic(logic, runCtx);
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
    ? (childMachine.provide({ actorSources: wrapped as never }) as AnyStateMachine)
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
 * (`options.actorSources` merged onto the machine), so a missing
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
  const maxModelCalls = options.maxModelCalls ?? 100;
  let modelCallCount = 0;
  let budgetExceeded = false;
  // Dev-only serialization guard: warn at most once per run when idle context
  // holds values that won't survive snapshot persist/resume (see settleIdle).
  let warnedNonSerializable = false;
  const runId = `run_${nextRunAgentTraceId++}`;
  let traceSeq = 0;

  // Version stamping (§ item 2): every settled snapshot carries a plain,
  // enumerable `agentMeta` field so it survives JSON persist/resume, and an
  // incoming snapshot's stamp is checked against this version on resume.
  const machineId = (machine.config as { id?: string }).id ?? machine.id ?? "(machine)";
  const machineVersion = options.machineVersion ?? getMachineStructuralHash(machine);
  const agentMeta = { machineId, version: machineVersion };
  const stampAgentMeta = (snapshot: unknown): void => {
    if (snapshot && typeof snapshot === "object") {
      (snapshot as { agentMeta?: unknown }).agentMeta = agentMeta;
    }
  };

  const onTrace = (event: AgentTraceEventPayload<TMachine>) => {
    options.onTrace?.({
      runId,
      seq: ++traceSeq,
      timestamp: new Date().toISOString(),
      ...event,
    } as AgentTraceEvent<TMachine>);
  };

  const consumeModelCall = () => {
    if (budgetExceeded) {
      throw new MaxModelCallsExceededError();
    }
    modelCallCount += 1;
    if (modelCallCount > maxModelCalls) {
      budgetExceeded = true;
      throw new MaxModelCallsExceededError();
    }
  };

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

  // §3.2 step 1: bind implementations. Conceptually `machine.provide({
  // actorSources: options.actorSources })` first, then walk the EFFECTIVE
  // (post-provide) sources (spike S4: chained provides merge).
  const provided = machine.provide({
    actorSources: options.actorSources as never,
  }) as TMachine;

  const effectiveSources = provided.implementations.actorSources as Record<string, AnyActorLogic>;

  assertBindable(provided, effectiveSources, {
    hasGenerateText: !!options.executors?.generateText,
    hasDecide: !!options.executors?.decide,
    hasStreamText: !!options.executors?.streamText,
  });

  const actorHolder: { actorRef: AnyActorRef | undefined } = { actorRef: undefined };
  const runCtx: RunAgentBindContext = {
    generateText: options.executors?.generateText,
    streamText: options.executors?.streamText,
    decide: options.executors?.decide,
    onChunk: options.onChunk,
    onResult: options.onResult,
    onTrace: onTrace as RunAgentBindContext["onTrace"],
    consumeModelCall,
    actorHolder,
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
        wrappedSources[key] = createAsyncLogic<unknown, AgentUserInput>({
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
        wrappedSources[key] = createAsyncLogic<unknown, AgentUserInput>({
          run: () => new Promise<never>(() => {}),
        });
      }
      continue;
    }

    if (isDecisionLogic(logic)) {
      wrappedSources[key] = createRunAgentDecisionLogic(logic, runCtx);
      continue;
    }

    if (isPlanLogic(logic)) {
      wrappedSources[key] = createRunAgentPlanLogic(logic, runCtx);
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
    actorSources: wrappedSources as never,
  }) as TMachine;

  // Resolution order: host override → machine-carried predicate
  // (`setupAgent({ isSuspended })`, read off the original machine so it survives
  // the provide/rebind above) → the timing heuristic (`() => false` here — the
  // inspect handler falls through to `scheduleIdleCheck`).
  const isSuspended =
    options.isSuspended ?? getMachineSuspensionPredicate(machine) ?? (() => false);

  // Version stamping (§ item 2): when resuming, compare the incoming snapshot's
  // stamped version against this machine's. A mismatch runs `migrateSnapshot`
  // (its return value is used) if provided, else `onVersionMismatch`
  // ('throw' | 'warn' | 'ignore'). An unstamped snapshot (no `agentMeta`) is
  // always accepted. The (possibly migrated) snapshot is threaded through the
  // illegal-resume check, createActor, and the run.start trace.
  let effectiveSnapshot = options.snapshot;
  if (effectiveSnapshot !== undefined) {
    const incoming = (effectiveSnapshot as { agentMeta?: { version?: string } }).agentMeta;
    const from = incoming?.version;
    if (from !== undefined && from !== machineVersion) {
      const info = { from, to: machineVersion };
      if (options.migrateSnapshot) {
        effectiveSnapshot = options.migrateSnapshot(effectiveSnapshot, info);
      } else {
        const mode = options.onVersionMismatch ?? "throw";
        if (mode === "throw") {
          throw new SnapshotVersionMismatchError(from, machineVersion, machineId);
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
      throw new IllegalResumeEventError(eventType, acceptedTypes);
    }
  }

  return new Promise<RunAgentResult<TMachine>>((resolvePromise) => {
    let settled = false;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let actor: ReturnType<typeof createActor<TMachine>>;
    // True only during the resumed actor's initial (restore) transition, while
    // an `event` is still pending delivery. The restored state may itself be a
    // suspended/idle snapshot; without this guard, Feature A's immediate settle
    // would fire during `start()` and settle idle BEFORE the resume event is
    // sent. Cleared right before `actor.send(options.event)`.
    let deliveringResumeEvent = options.event !== undefined;

    const settle = (result: RunAgentResult<TMachine>) => {
      if (settled) {
        return;
      }
      settled = true;
      if (idleTimer !== undefined) {
        clearTimeout(idleTimer);
      }
      if (options.signal) {
        options.signal.removeEventListener("abort", onAbort);
      }
      // Stamp the settled snapshot(s) with the machine id + version. A plain
      // enumerable field (snapshots are not frozen), so it survives JSON
      // persist/resume and is read back on the next resume's version check.
      stampAgentMeta(result.snapshot);
      if ("persistedSnapshot" in result) {
        stampAgentMeta(result.persistedSnapshot);
      }
      onTrace({ type: "run.end", ...result } as AgentTraceEventPayload<TMachine>);
      actor.stop();
      resolvePromise(result);
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
        ...(pendingUserInputs.length > 0
          ? {
              pendingUserInputs,
              persistedSnapshot: actor.getPersistedSnapshot() as Snapshot<unknown>,
            }
          : {}),
      });
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
          settleIdle(current);
        }
      }, 0);
    };

    actor = createActor(boundMachine, {
      input: options.input as never,
      snapshot: effectiveSnapshot,
      inspect: (event: InspectionEvent) => {
        // System-wide passthrough (children included) before runAgent's own
        // root-transition filtering below.
        options.inspect?.(event);

        if (
          settled ||
          event.type !== "@xstate.transition" ||
          (event.actorRef as unknown) !== (actor.ref as unknown)
        ) {
          return;
        }

        const snapshot = event.snapshot as AnyMachineSnapshot;

        onTrace({
          type: "machine.transition",
          snapshot: snapshot as SnapshotFrom<TMachine>,
          event: event.event as EventFromLogic<TMachine>,
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
          // DecisionExhaustedError surfacing here is genuinely unhandled.
          const cause: RunAgentErrorCause = budgetExceeded
            ? "max-model-calls"
            : wrapsDecisionExhausted(snapshot.error)
              ? "decision-exhausted"
              : "machine";
          settle({
            status: "error",
            cause,
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
          settleIdle(snapshot);
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

    if (options.signal) {
      if (options.signal.aborted) {
        settle({
          status: "error",
          cause: "aborted",
          error: options.signal.reason ?? new Error("Aborted"),
          snapshot: actor.getSnapshot(),
        });
        return;
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
  });
}

/**
 * Runs an agent machine to a **final state** and returns its output, for
 * run-to-done flows where an idle pause is unexpected. Wraps {@link runAgent}:
 *
 * - `done` → resolves with `result.output` (the machine's `OutputFrom`).
 * - `idle` → throws {@link AgentIdleError} carrying the idle snapshot and the
 *   event types that could resume it.
 * - `error` → throws `result.error` when it is an `Error`; otherwise wraps it
 *   in an `Error` whose `.cause` is the {@link RunAgentErrorCause} and whose
 *   `.error` is the raw thrown value.
 *
 * Use {@link runAgent} directly when idle is an expected outcome you handle
 * (human-in-the-loop, resumable flows); use `runAgentToCompletion` when the
 * machine is meant to run straight through to a final state.
 */
export async function runAgentToCompletion<TMachine extends AnyStateMachine>(
  machine: TMachine,
  options: RunAgentOptions<TMachine>,
): Promise<OutputFrom<TMachine>> {
  const result = await runAgent(machine, options);
  if (result.status === "done") {
    return result.output;
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
  const wrapped = new Error(`runAgentToCompletion: run failed with cause '${result.cause}'.`);
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

// True when a snapshot is active but has no in-flight children and no pending eventless/after work — see §3.3 in docs/p0-design.md for the approximation this makes. `ignoreUserInputChildren` exempts pending `agent.userInput` placeholder children (they wait for a human indefinitely and must not block an idle settle).
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
    return ref?.getSnapshot?.()?.status === "active";
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

// Gathers the still-active `agent.userInput` placeholder children off an idle snapshot: one {@link PendingUserInput} per pending invoke, with the invoke's resolved input (prompt, schema, …) read off the child's own snapshot.
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
