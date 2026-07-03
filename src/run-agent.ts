import {
  createActor,
  createAsyncLogic,
  getNextTransitions,
  type AnyActorLogic,
  type AnyActorRef,
  type AnyMachineSnapshot,
  type AnyStateMachine,
  type EventFromLogic,
  type InputFrom,
  type InspectionEvent,
  type OutputFrom,
  type Snapshot,
  type SnapshotFrom,
} from 'xstate';
import type { AgentTools, ChosenEvent } from './types.js';
import { getAcceptedEvents, type AgentSchemas } from './events.js';
import {
  isTextLogic,
  normalizeGeneratorResult,
  USER_INPUT_ACTOR,
  type AgentRequestExecutor,
  type AgentRequestExecutors,
  type AgentTextRequest,
  type AgentUserInput,
  type TextLogic,
} from './text-logic.js';
import {
  isDecisionLogic,
  resolveDecision,
  type AgentDecisionExecutor,
  type AgentDecisionRequest,
  type DecisionLogic,
} from './decision.js';
import type { AgentRequest, AgentStepRequest } from './steps.js';
import {
  executorBoundLogics,
  getRegisteredAgentExecutionOptions,
  isUnboundPlaceholder,
} from './internal/registry.js';

// ─── runAgent (createActor wrapper) ───
//
// See docs/p0-design.md §3. Unlike the step helpers above (a pure
// transition-at-a-time path for durable hosts), `runAgent` owns a live
// `createActor` actor: it binds host executors directly onto the machine's
// agent actor sources, runs the actor to completion or idle, and reports a
// `done | idle | error` result. There is no continuation callback — idle
// always settles and the caller resumes by snapshot (§3.4).

export interface AgentUserInputExecutor {
  (input: AgentUserInput): PromiseLike<unknown>;
}

export interface RunAgentOptions<TMachine extends AnyStateMachine>
  extends AgentRequestExecutors {
  input?: InputFrom<TMachine>;

  // resume
  snapshot?: Snapshot<unknown>;
  event?: EventFromLogic<TMachine>;

  // implementations — sugar for machine.provide({ actorSources }) before the run
  actorSources?: Record<string, AnyActorLogic>;

  /**
   * Optional human-input handler for `agent.userInput` invokes (CLI prompt,
   * web form, Slack, …). Idle-first HITL stays the default: model human input
   * as event-waiting states and `runAgent` settles `idle`. Provide this only
   * when input should be gathered inline without settling. If the machine
   * uses `agent.userInput` and neither this nor a provided actor source
   * handles it, binding fails fast (message recommends the idle-state
   * pattern).
   */
  userInput?: AgentUserInputExecutor;

  // observation — all void; no callback controls the run
  onChunk?: (chunk: string, info: { request: AgentRequest }) => void;
  onResult?: (
    request: AgentStepRequest,
    result: { output: unknown; raw: unknown }
  ) => void;
  /**
   * Fires on every machine transition (snapshot + causing event). Pure
   * observation — progress UIs, logging, tracing. Cannot send events.
   */
  onTransition?: (
    snapshot: SnapshotFrom<TMachine>,
    event: EventFromLogic<TMachine>
  ) => void;

  // control
  maxModelCalls?: number; // default 100
  signal?: AbortSignal;
}

export type RunAgentResult<TMachine extends AnyStateMachine> =
  | { status: 'done'; output: OutputFrom<TMachine>; snapshot: SnapshotFrom<TMachine> }
  | { status: 'idle'; snapshot: SnapshotFrom<TMachine> }
  | {
      status: 'error';
      cause: 'aborted' | 'max-model-calls' | 'machine';
      error: unknown;
      snapshot: SnapshotFrom<TMachine>;
    };

class MaxModelCallsExceededError extends Error {
  constructor() {
    super('runAgent exceeded maxModelCalls.');
    this.name = 'MaxModelCallsExceededError';
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
  out: Array<{ stateName: string; src: string | AnyActorLogic }>
): void {
  if (!stateConfig) {
    return;
  }

  const invokes = stateConfig.invoke === undefined
    ? []
    : Array.isArray(stateConfig.invoke)
      ? stateConfig.invoke
      : [stateConfig.invoke];

  for (const invokeConfig of invokes) {
    const src = (invokeConfig as { src?: unknown } | undefined)?.src;
    if (typeof src === 'string' || (src && typeof src === 'object')) {
      out.push({ stateName, src: src as string | AnyActorLogic });
    }
    // Function-valued `src` resolvers are dynamic; not walked (see above).
  }

  for (const [childName, childConfig] of Object.entries(stateConfig.states ?? {})) {
    collectConfiguredInvokeSrcs(childConfig, `${stateName}.${childName}`, out);
  }
}

/**
 * Fails fast (throws) at bind time — before any actor runs — when the
 * machine invokes an agent actor `runAgent` cannot execute. See §3.2 point 2.
 */
function assertBindable(
  machine: AnyStateMachine,
  effectiveSources: Record<string, AnyActorLogic>,
  options: { hasDecide: boolean; hasStreamText: boolean; hasUserInput: boolean }
): void {
  const invokes: Array<{ stateName: string; src: string | AnyActorLogic }> = [];
  collectConfiguredInvokeSrcs(machine.config as never, machine.config.id ?? '(root)', invokes);

  for (const { stateName, src } of invokes) {
    if (typeof src !== 'string') {
      // Direct-object src: string-keyed sources can be rebound by runAgent;
      // direct objects cannot. Only a problem if it's an agent logic that
      // still needs execution (no executor of its own).
      if (
        (isTextLogic(src) || isDecisionLogic(src))
        && !executorBoundLogics.has(src as object)
      ) {
        throw new Error(
          `runAgent: state '${stateName}' invokes a direct-object actor logic ` +
            `(kind: '${(src as TextLogic | DecisionLogic).kind}'). Direct-object invoke ` +
            `srcs cannot be rebound by runAgent — either call '.withExecutor(...)' on ` +
            `the logic before invoking it, or register it as a string-keyed actor ` +
            `source instead (machine.provide({ actorSources: { name: logic } })) and ` +
            `invoke it by name.`
        );
      }
      continue;
    }

    const logic = effectiveSources[src];

    if (logic === undefined) {
      throw new Error(
        `runAgent: state '${stateName}' invokes unregistered actor source '${src}'. ` +
          `Provide it via machine.provide({ actorSources: { '${src}': ... } }) or ` +
          `runAgent(machine, { actorSources: { '${src}': ... } }).`
      );
    }

    if (src === USER_INPUT_ACTOR) {
      if (!options.hasUserInput && isUnboundPlaceholder(logic)) {
        throw new Error(
          `runAgent: state '${stateName}' invokes '${USER_INPUT_ACTOR}' but no ` +
            `'userInput' option or actor source was provided. Either pass ` +
            `{ userInput: async (input) => ... } to runAgent, provide an actor ` +
            `source for '${USER_INPUT_ACTOR}', or model this as an idle state ` +
            `that waits for an externally-sent event instead.`
        );
      }
      continue;
    }

    if (isDecisionLogic(logic)) {
      if (!options.hasDecide) {
        throw new Error(
          `runAgent: state '${stateName}' invokes decision source '${src}' but no ` +
            `'decide' executor was provided to runAgent(...).`
        );
      }
      continue;
    }

    if (isTextLogic(logic)) {
      if (logic.mode === 'stream' && !options.hasStreamText) {
        throw new Error(
          `runAgent: state '${stateName}' invokes streaming text source '${src}' but ` +
            `no 'streamText' executor was provided to runAgent(...).`
        );
      }
      continue;
    }

    if (isUnboundPlaceholder(logic)) {
      throw new Error(
        `runAgent: state '${stateName}' invokes actor source '${src}', which has no ` +
          `host execution. Provide it via machine.provide({ actorSources: { '${src}': ... } }) ` +
          `or runAgent(machine, { actorSources: { '${src}': ... } }).`
      );
    }

    // Non-agent actor (real run fn) — passes through untouched.
  }
}

interface RunAgentBindContext {
  generateText: AgentRequestExecutor;
  streamText?: AgentRequestExecutor;
  decide?: AgentDecisionExecutor;
  onChunk?: (chunk: string, info: { request: AgentRequest }) => void;
  onResult?: (
    request: AgentStepRequest,
    result: { output: unknown; raw: unknown }
  ) => void;
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
    id: typeof ref?.id === 'string' ? ref.id : '',
    src: typeof ref?.src === 'string' ? ref.src : '',
  };
}

function wrapTextLogicForRunAgent(
  logic: TextLogic,
  runCtx: RunAgentBindContext
): TextLogic {
  return logic.withExecutor(async ({ request, self, signal }) => {
    const { id, src } = selfIdAndSrc(self);
    const executor = logic.mode === 'stream' ? runCtx.streamText : runCtx.generateText;
    if (!executor) {
      throw new Error(
        `runAgent: no '${logic.mode === 'stream' ? 'streamText' : 'generateText'}' ` +
          'executor provided.'
      );
    }

    const requestWithTools: AgentTextRequest & { tools: AgentTools } = {
      ...request,
      tools: request.tools ?? {},
    };
    const agentRequest: AgentRequest = {
      kind: 'text',
      id,
      src,
      mode: logic.mode,
      input: request,
      tools: requestWithTools.tools,
      events: [],
    };

    runCtx.consumeModelCall();
    const raw = await executor(requestWithTools, {
      onChunk: runCtx.onChunk
        ? (chunk: string) => runCtx.onChunk!(chunk, { request: agentRequest })
        : undefined,
      signal,
    });
    const output = await normalizeGeneratorResult(raw);

    runCtx.onResult?.(agentRequest, { output, raw });

    return output;
  });
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
  runCtx: RunAgentBindContext
): DecisionLogic {
  const decisionLogic = createAsyncLogic<ChosenEvent, unknown>({
    run: async ({ input, signal, self }) => {
      if (!runCtx.decide) {
        throw new Error("runAgent: no 'decide' executor provided.");
      }
      const { id, src } = selfIdAndSrc(self);

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

      const countingDecide: AgentDecisionExecutor = async (attemptRequest) => {
        runCtx.consumeModelCall();
        const result = await runCtx.decide!(attemptRequest);
        runCtx.onResult?.(attemptRequest, { output: result.event, raw: result });
        return result;
      };

      return resolveDecision(request, countingDecide, {
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
    kind: 'statelyai.decisionLogic' as const,
    maxRetries: logic.maxRetries,
    request: logic.request,
    withExecutor: (nextExecute: AgentDecisionExecutor) =>
      createRunAgentDecisionLogic(logic.withExecutor(nextExecute), runCtx),
  }) as DecisionLogic;
}

export async function runAgent<TMachine extends AnyStateMachine>(
  machine: TMachine,
  options: RunAgentOptions<TMachine>
): Promise<RunAgentResult<TMachine>> {
  const maxModelCalls = options.maxModelCalls ?? 100;
  let modelCallCount = 0;
  let budgetExceeded = false;

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

  const effectiveSources = provided.implementations.actorSources as Record<
    string,
    AnyActorLogic
  >;

  assertBindable(provided, effectiveSources, {
    hasDecide: !!options.decide,
    hasStreamText: !!options.streamText,
    hasUserInput: !!options.userInput,
  });

  const actorHolder: { actorRef: AnyActorRef | undefined } = { actorRef: undefined };
  const runCtx: RunAgentBindContext = {
    generateText: options.generateText,
    streamText: options.streamText,
    decide: options.decide,
    onChunk: options.onChunk,
    onResult: options.onResult,
    consumeModelCall,
    actorHolder,
    schemas: getRegisteredAgentExecutionOptions(machine).schemas,
  };

  // §3.2 step 2: wrap every effective TextLogic/DecisionLogic (and the
  // agent.* builtins) with a host-backed executor. Every other source (plain
  // actors, non-agent logic) passes through untouched.
  const wrappedSources: Record<string, AnyActorLogic> = {};
  for (const [key, logic] of Object.entries(effectiveSources)) {
    if (key === USER_INPUT_ACTOR) {
      if (options.userInput) {
        const userInput = options.userInput;
        wrappedSources[key] = createAsyncLogic<unknown, AgentUserInput>({
          run: async ({ input }) => await userInput(input),
        });
      }
      continue;
    }

    if (isDecisionLogic(logic)) {
      wrappedSources[key] = createRunAgentDecisionLogic(logic, runCtx);
      continue;
    }

    if (isTextLogic(logic)) {
      wrappedSources[key] = wrapTextLogicForRunAgent(logic, runCtx);
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
        options.signal.removeEventListener('abort', onAbort);
      }
      actor.stop();
      resolvePromise(result);
    };

    const onAbort = () => {
      settle({
        status: 'error',
        cause: 'aborted',
        error: options.signal?.reason ?? new Error('Aborted'),
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
        if (isIdleSnapshot(current)) {
          settle({
            status: 'idle',
            snapshot: current as SnapshotFrom<TMachine>,
          });
        }
      }, 0);
    };

    actor = createActor(boundMachine, {
      input: options.input as never,
      snapshot: options.snapshot,
      inspect: (event: InspectionEvent) => {
        if (
          settled
          || event.type !== '@xstate.transition'
          || (event.actorRef as unknown) !== (actor.ref as unknown)
        ) {
          return;
        }

        const snapshot = event.snapshot as AnyMachineSnapshot;

        options.onTransition?.(
          snapshot as SnapshotFrom<TMachine>,
          event.event as EventFromLogic<TMachine>
        );

        if (snapshot.status === 'done') {
          settle({
            status: 'done',
            output: snapshot.output as OutputFrom<TMachine>,
            snapshot: snapshot as SnapshotFrom<TMachine>,
          });
          return;
        }

        if (snapshot.status === 'error') {
          settle({
            status: 'error',
            cause: budgetExceeded ? 'max-model-calls' : 'machine',
            error: snapshot.error,
            snapshot: snapshot as SnapshotFrom<TMachine>,
          });
          return;
        }

        if (snapshot.status === 'stopped') {
          settle({
            status: 'error',
            cause: 'machine',
            error: new Error('Actor stopped externally.'),
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

    if (options.signal) {
      if (options.signal.aborted) {
        settle({
          status: 'error',
          cause: 'aborted',
          error: options.signal.reason ?? new Error('Aborted'),
          snapshot: actor.getSnapshot(),
        });
        return;
      }
      options.signal.addEventListener('abort', onAbort);
    }

    actor.start();
    if (options.event) {
      actor.send(options.event as never);
    }
  });
}

function isIdleSnapshot(snapshot: AnyMachineSnapshot): boolean {
  if (snapshot.status !== 'active') {
    return false;
  }
  const childrenBusy = Object.values(snapshot.children ?? {}).some(
    (child) => (child as AnyActorRef | undefined)?.getSnapshot?.()?.status === 'active'
  );
  if (childrenBusy) {
    return false;
  }
  const hasPendingWork = getNextTransitions(snapshot).some(
    (transitionDef) =>
      transitionDef.eventType === ''
      || transitionDef.eventType.startsWith('xstate.after')
  );
  return !hasPendingWork;
}
