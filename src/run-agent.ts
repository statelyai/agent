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
import { getAcceptedEvents, type AgentSchemas } from "./events.js";
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
  isDecisionLogic,
  isPlanLogic,
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
          cause: "aborted" | "max-model-calls" | "machine";
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
 * Options for {@link runAgent}. Extends {@link AgentRequestExecutors}
 * (`generateText` required; `streamText`/`decide` required only if the
 * machine actually uses streaming text / decisions — checked at bind time,
 * before any actor runs).
 */
export interface RunAgentOptions<TMachine extends AnyStateMachine>
  extends
    Partial<Pick<AgentRequestExecutors, "generateText">>,
    Omit<AgentRequestExecutors, "generateText"> {
  /** Machine input, passed straight to `createActor(machine, { input })`. Omit when resuming via `snapshot`. */
  input?: InputFrom<TMachine>;

  // resume
  /** A previously-settled run's `result.snapshot`, to resume from instead of starting fresh. Pair with `event` to deliver the event that unblocks the resumed idle state. */
  snapshot?: Snapshot<unknown>;
  /** An event to send immediately after starting/resuming the actor (e.g. the human's answer to an idle-state prompt). */
  event?: EventFromLogic<TMachine>;

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
 * failure, discriminated by `cause` (`'aborted'`, `'max-model-calls'`, or
 * `'machine'` for a machine error state / decision-exhausted / external
 * stop). Every variant carries the final `snapshot`, and the underlying
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
      cause: "aborted" | "max-model-calls" | "machine";
      error: unknown;
      snapshot: SnapshotFrom<TMachine>;
    };

// Thrown internally by consumeModelCall() past the budget; caught by runAgent's settle loop to produce a 'max-model-calls' error result.
let nextRunAgentTraceId = 1;

class MaxModelCallsExceededError extends Error {
  constructor() {
    super("runAgent exceeded maxModelCalls.");
    this.name = "MaxModelCallsExceededError";
  }
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
 * Recurses into invoked child state machines (arbitrarily deep), because a
 * child machine's own agent requests do NOT inherit the parent runAgent's
 * `generateText`/`streamText`/`decide` executors at runtime — the runtime
 * only wraps the parent machine's own sources, treating an invoked child as
 * one opaque actor. So a child request must carry its own executor
 * (`.withExecutor(...)`, tracked in `executorBoundLogics`) or be bound as a
 * string-keyed source inside the child (via nested `.provide`). Anything
 * unbound would silently settle the parent in its invoking state at runtime;
 * this walk turns that into a loud bind-time error naming the child and the
 * request, with the nested-`.provide` fix.
 */
function assertBindable(
  machine: AnyStateMachine,
  effectiveSources: Record<string, AnyActorLogic>,
  options: { hasGenerateText: boolean; hasDecide: boolean; hasStreamText: boolean },
): void {
  assertMachineBindable(machine, effectiveSources, options, {
    isChild: false,
    childPath: "",
    visited: new Set([machine]),
  });
}

/** Recursion frame for {@link assertBindable}. `isChild` flips the error
 * messages to the nested-`.provide` remedy (child requests can't inherit
 * parent executors); `childPath` names the invoke chain (`parent > child`);
 * `visited` guards against a machine invoking itself recursively. */
interface BindWalkContext {
  isChild: boolean;
  childPath: string;
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
      if (ctx.isChild) {
        throw unboundChildRequestError(ctx.childPath, stateName, src, "decision");
      }
      if (!options.hasDecide) {
        throw new Error(
          `runAgent: state '${stateName}' invokes decision source '${src}' but no ` +
            `'decide' executor was provided to runAgent(...).`,
        );
      }
      continue;
    }

    if (isPlanLogic(logic)) {
      // Plans resolve steps through the same `decide` executor.
      if (ctx.isChild) {
        throw unboundChildRequestError(ctx.childPath, stateName, src, "plan");
      }
      if (!options.hasDecide) {
        throw new Error(
          `runAgent: state '${stateName}' invokes plan source '${src}' but no ` +
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
      if (ctx.isChild) {
        // Child requests never inherit parent executors — the only fix is to
        // bind the child's request with its own executor.
        throw unboundChildRequestError(
          ctx.childPath,
          stateName,
          src,
          logic.mode === "stream" ? "streaming text" : "text",
        );
      }
      if (logic.mode === "stream" && !options.hasStreamText) {
        throw new Error(
          `runAgent: state '${stateName}' invokes streaming text source '${src}' but ` +
            `no 'streamText' executor was provided to runAgent(...).`,
        );
      }
      if (logic.mode !== "stream" && !options.hasGenerateText) {
        throw new Error(
          `runAgent: state '${stateName}' invokes text source '${src}' but ` +
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

  assertMachineBindable(childMachine, childSources, options, {
    isChild: true,
    childPath,
    visited: new Set([...ctx.visited, childMachine]),
  });
}

/** The loud bind-time error for an unbound agent request reached inside an
 * invoked child machine. Names the child invoke chain AND the request src,
 * and spells out the nested-`.provide`/`.withExecutor` remedy — child machine
 * requests do NOT inherit the parent runAgent's executors. */
function unboundChildRequestError(
  childPath: string,
  stateName: string,
  requestSrc: string,
  kind: "text" | "streaming text" | "decision" | "plan",
): Error {
  return new Error(
    `runAgent: child machine '${childPath}' (state '${stateName}') invokes ${kind} ` +
      `source '${requestSrc}', which has no host execution. Child machine requests do ` +
      `NOT inherit the parent runAgent's generateText/streamText/decide executors — the ` +
      `child must be bound before it is invoked. Bind it via ` +
      `parentMachine.provide({ actorSources: { <child>: childMachine.provide({ ` +
      `actorSources: { '${requestSrc}': requestLogic.withExecutor(...) } }) } }), or pass ` +
      `that same nested-provided child as runAgent(parentMachine, { actorSources: { ` +
      `<child>: childMachine.provide({ actorSources: { '${requestSrc}': ` +
      `requestLogic.withExecutor(...) } }) } }).`,
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
      const output = await normalizeGeneratorResult(raw, id);

      runCtx.onResult?.(agentRequest, { output, raw });
      runCtx.onTrace?.({ type: "request.end", request: agentRequest, output, raw });

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
      const actorRef = runCtx.actorHolder.actorRef;
      const events = actorRef
        ? getAcceptedEvents(actorRef.getSnapshot() as AnyMachineSnapshot, {
            schemas: runCtx.schemas,
            eventTypes: declaredEventTypes,
          })
        : [];

      const request: AgentDecisionRequest = { ...logic.request(input as never), id, events };

      return resolveDecision(request, createCountingDecide(runCtx), {
        maxRetries: logic.maxRetries,
        signal,
        canTake: (event) => {
          const actorRef = runCtx.actorHolder.actorRef;
          return actorRef ? (actorRef.getSnapshot() as AnyMachineSnapshot).can(event) : true;
        },
      });
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
      const maxSteps = input.maxSteps ?? 8;
      const stopOn = new Set<string>(input.stopOn ?? []);
      const steps: ChosenEvent[] = [];
      const countingDecide = createCountingDecide(runCtx);
      const base = logic.request(input);

      // Same microtask yield as the decision wrapper: let the invoking
      // transition commit before the first snapshot read.
      await Promise.resolve();

      while (steps.length < maxSteps) {
        const actorRef = runCtx.actorHolder.actorRef;
        if (!actorRef || signal.aborted) {
          break;
        }
        const snapshot = actorRef.getSnapshot() as AnyMachineSnapshot;
        const events = getAcceptedEvents(snapshot, {
          schemas: runCtx.schemas,
          eventTypes: logic.allowedEventTypes(input),
        });
        if (events.length === 0) {
          return { steps, stopped: "no-legal-events" };
        }

        const trail =
          steps.length === 0
            ? ""
            : `\n\nEvents already applied in this plan, in order:\n${steps
                .map((step) => JSON.stringify(step))
                .join("\n")}\nContinue from here; do not repeat applied events.`;
        const request: AgentDecisionRequest = {
          ...base,
          id: `${id}[${steps.length}]`,
          events,
          prompt: base.prompt === undefined && trail === "" ? undefined : `${base.prompt ?? ""}${trail}`,
          attempts: [],
        };

        const chosen = await resolveDecision(request, countingDecide, {
          maxRetries: input.maxRetries ?? logic.maxRetries,
          signal,
          canTake: (event) => {
            // A stopOn event terminates the plan rather than driving a
            // transition — a pure no-op handler (`NOTHING: {}`) makes
            // `snapshot.can(...)` false, so exempt stop events from the check.
            if (stopOn.has(event.type)) {
              return true;
            }
            const ref = runCtx.actorHolder.actorRef;
            return ref ? (ref.getSnapshot() as AnyMachineSnapshot).can(event) : true;
          },
        });

        steps.push(chosen);
        actorRef.send(chosen as never);
        // Let the applied transition commit before the next snapshot read
        // (and let xstate cancel this invoke if the event exited the state).
        await Promise.resolve();

        if (stopOn.has(chosen.type)) {
          return { steps, stopped: "stop-event" };
        }
      }

      return { steps, stopped: "max-steps" };
    },
  });

  return Object.assign(planLogic, {
    kind: "statelyai.planLogic" as const,
    maxRetries: logic.maxRetries,
    request: logic.request,
    allowedEventTypes: logic.allowedEventTypes,
  }) as PlanLogic;
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
 * let r = await runAgent(machine, { input, ...executors });
 * while (r.status === 'idle') {
 *   const event = await promptUser(getAcceptedEvents(r.snapshot));
 *   r = await runAgent(machine, { snapshot: r.snapshot, event, ...executors });
 * }
 * if (r.status !== 'done') throw new Error(`Run did not complete: ${r.status}`);
 * console.log(r.output);
 * ```
 */
export async function runAgent<TMachine extends AnyStateMachine>(
  machine: TMachine,
  options: RunAgentOptions<TMachine>,
): Promise<RunAgentResult<TMachine>> {
  const maxModelCalls = options.maxModelCalls ?? 100;
  let modelCallCount = 0;
  let budgetExceeded = false;
  const runId = `run_${nextRunAgentTraceId++}`;
  let traceSeq = 0;

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

  // §3.2 step 1: bind implementations. Conceptually `machine.provide({
  // actorSources: options.actorSources })` first, then walk the EFFECTIVE
  // (post-provide) sources (spike S4: chained provides merge).
  const provided = machine.provide({
    actorSources: options.actorSources as never,
  }) as TMachine;

  const effectiveSources = provided.implementations.actorSources as Record<string, AnyActorLogic>;

  assertBindable(provided, effectiveSources, {
    hasGenerateText: !!options.generateText,
    hasDecide: !!options.decide,
    hasStreamText: !!options.streamText,
  });

  const actorHolder: { actorRef: AnyActorRef | undefined } = { actorRef: undefined };
  const runCtx: RunAgentBindContext = {
    generateText: options.generateText,
    streamText: options.streamText,
    decide: options.decide,
    onChunk: options.onChunk,
    onResult: options.onResult,
    onTrace: onTrace as RunAgentBindContext["onTrace"],
    consumeModelCall,
    actorHolder,
    schemas: getRegisteredAgentExecutionOptions(machine).schemas,
  };

  // §3.2 step 2: wrap every effective TextLogic/DecisionLogic (and the
  // agent.* builtins) with a host-backed executor. Every other source (plain
  // actors, non-agent logic) passes through untouched.
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
    // Non-agent actors and already-unreachable placeholders pass through
    // untouched — assertBindable already rejected reachable placeholders.
  }

  const boundMachine = provided.provide({
    actorSources: wrappedSources as never,
  }) as TMachine;

  return new Promise<RunAgentResult<TMachine>>((resolvePromise) => {
    let settled = false;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let actor: ReturnType<typeof createActor<TMachine>>;

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
        }
      }, 0);
    };

    actor = createActor(boundMachine, {
      input: options.input as never,
      snapshot: options.snapshot,
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
          settle({
            status: "error",
            cause: budgetExceeded ? "max-model-calls" : "machine",
            error: snapshot.error,
            snapshot: snapshot as SnapshotFrom<TMachine>,
          });
          return;
        }

        if (snapshot.status === "stopped") {
          settle({
            status: "error",
            cause: "machine",
            error: new Error("Actor stopped externally."),
            snapshot: snapshot as SnapshotFrom<TMachine>,
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
      ...(options.snapshot !== undefined ? { snapshot: options.snapshot } : {}),
      ...(options.event !== undefined ? { event: options.event } : {}),
    });

    actor.start();
    if (options.event) {
      actor.send(options.event as never);
    }
  });
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
