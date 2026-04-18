import type {
  AgentMachine,
  AgentSnapshot,
  AgentState,
  EmittedPart,
  EventPayload,
  ExecuteResult,
  InferOutput,
  MachineConfig,
  StandardSchemaV1,
  TransitionResult,
} from './types.js';
import type { JournalEvent } from './runtime/events.js';
import {
  applyTransition,
  findEmittedSchema,
  findEventSchema,
  formatSchemaIssues,
  getAvailableEvents,
  getInput,
  isDoneInvokeEventType,
  isErrorInvokeEventType,
  resolveInitial,
  resolveStateConfig,
  serializeError,
  validateSchemaSync,
} from './utils.js';
import type { StateConfigAny } from './utils.js';

// ─── Type helpers ───
/** Result type for onDone: typed from invoke return or resultSchema when present */
type OnDoneResult<TResult> = NoInfer<TResult>;

type EventFor<TEvents, E> = E extends keyof TEvents & string
  ? { type: E } & EventPayload<InferOutput<TEvents[E & keyof TEvents]>>
  : { type: E & string; [k: string]: unknown };

type StateNodeDef<
  TState,
  TContext extends Record<string, unknown>,
  TInput,
  TResult,
  TEvents,
  TTarget extends string,
  TInputMap extends Record<string, any>,
  TOutput,
> = {
  type?: 'final' | 'choice';
  inputSchema?: StandardSchemaV1<TInput>;
  resultSchema?: StandardSchemaV1<TResult>;
  invoke?: (args: {
    context: TContext;
    input: NoInfer<TInput>;
    signal?: AbortSignal;
  }, enq: { emit(part: EmittedPart): void }) => Promise<TResult>;
  onDone?: (args: { result: OnDoneResult<TResult>; context: TContext }) => TransitionResult<TContext, TTarget, TInputMap>;
  on?: { [E in keyof TEvents & string]?: TransitionResult<TContext, TTarget, TInputMap> | ((args: {
      event: EventFor<TEvents, E>;
      context: TContext;
    }, enq: { emit(part: EmittedPart): void }) => TransitionResult<TContext, TTarget, TInputMap>) };
  events?: Record<string, StandardSchemaV1>;
  output?: (args: { context: TContext }) => NoInfer<TOutput>;
  model?: string;
  adapter?: import('./types.js').AgentAdapter;
  prompt?: string | ((args: { context: TContext; input: NoInfer<TInput> }) => string);
  options?: Record<string, { description: string; schema?: StandardSchemaV1 }>;
  reasoning?: boolean;
};

type StatesMap<
  TContext extends Record<string, unknown>,
  TInputMap extends Record<string, any>,
  TResultMap extends Record<string, any>,
  TOutput,
  TEvents,
> = {
  [K in keyof TInputMap & keyof TResultMap]: StateNodeDef<
    unknown,
    TContext,
    TInputMap[K],
    TResultMap[K],
    TEvents,
    keyof TInputMap & keyof TResultMap & string,
    TInputMap,
    TOutput
  >;
};

// ─── Overload A: schemas.context present ───
export function createAgentMachine<
  TInput,
  TContext extends Record<string, unknown>,
  const TEvents extends Record<string, StandardSchemaV1>,
  const TInputMap extends Record<string, any>,
  TResultMap extends Record<string, any>,
  const TEmitted extends Record<string, StandardSchemaV1>,
  TOutput = unknown,
>(config: {
  id: string;
  schemas: {
    context: StandardSchemaV1<TContext>;
    input?: StandardSchemaV1<TInput>;
    events?: TEvents;
    emitted?: TEmitted;
    output?: StandardSchemaV1<TOutput>;
  };
  context: (input: NoInfer<TInput>) => NoInfer<TContext>;
  adapter?: import('./types.js').AgentAdapter;
  initial:
    | (keyof TInputMap & keyof TResultMap & string)
    | ((args: { context: NoInfer<TContext> }) => {
        target: keyof TInputMap & keyof TResultMap & string;
        input?: Record<string, unknown>;
      });
  states: StatesMap<NoInfer<TContext>, TInputMap, TResultMap, TOutput, TEvents>;
}): AgentMachine<TInput, TContext, TEvents, StatesMap<TContext, TInputMap, TResultMap, TOutput, TEvents>, TOutput, TEmitted>;

// ─── Overload B: no schemas.context ───
export function createAgentMachine<
  TInput,
  TContext extends Record<string, unknown>,
  const TEvents extends Record<string, StandardSchemaV1>,
  const TInputMap extends Record<string, any>,
  TResultMap extends Record<string, any>,
  const TEmitted extends Record<string, StandardSchemaV1>,
  TOutput = unknown,
>(config: {
  id: string;
  schemas: {
    input: StandardSchemaV1<TInput>;
    context?: never;
    events?: TEvents;
    emitted?: TEmitted;
    output?: StandardSchemaV1<TOutput>;
  };
  context: (input: NoInfer<TInput>) => TContext;
  adapter?: import('./types.js').AgentAdapter;
  initial:
    | (keyof TInputMap & keyof TResultMap & string)
    | ((args: { context: TContext }) => {
        target: keyof TInputMap & keyof TResultMap & string;
        input?: Record<string, unknown>;
      });
  states: StatesMap<TContext, TInputMap, TResultMap, TOutput, TEvents>;
}): AgentMachine<TInput, TContext, TEvents, StatesMap<TContext, TInputMap, TResultMap, TOutput, TEvents>, TOutput, TEmitted>;

// ─── Overload C: no schemas.input or schemas.context ───
export function createAgentMachine<
  TContext extends Record<string, unknown>,
  const TEvents extends Record<string, StandardSchemaV1>,
  const TInputMap extends Record<string, any>,
  TResultMap extends Record<string, any>,
  const TEmitted extends Record<string, StandardSchemaV1>,
  TOutput = unknown,
>(config: {
  id: string;
  schemas?: {
    input?: never;
    context?: never;
    events?: TEvents;
    emitted?: TEmitted;
    output?: StandardSchemaV1<TOutput>;
  };
  context: (...args: any[]) => TContext;
  adapter?: import('./types.js').AgentAdapter;
  initial:
    | (keyof TInputMap & keyof TResultMap & string)
    | ((args: { context: TContext }) => {
        target: keyof TInputMap & keyof TResultMap & string;
        input?: Record<string, unknown>;
      });
  states: StatesMap<TContext, TInputMap, TResultMap, TOutput, TEvents>;
}): AgentMachine<unknown, TContext, TEvents, StatesMap<TContext, TInputMap, TResultMap, TOutput, TEvents>, TOutput, TEmitted>;

// ─── Implementation ───

export function createAgentMachine(
  machineConfig: MachineConfig<any, any, any, any, any>
): AgentMachine {
  const cfg = machineConfig as MachineConfig;

  type SnapshotRuntime = { sessionId: string; createdAt: number };

  function createSnapshotRuntime(state: AgentState) {
    if (state.sessionId && state.createdAt !== undefined) {
      return {
        sessionId: state.sessionId,
        createdAt: state.createdAt,
      };
    }

    const sessionId =
      typeof globalThis.crypto !== 'undefined' &&
      typeof globalThis.crypto.randomUUID === 'function'
        ? globalThis.crypto.randomUUID()
        : `session-${Math.random().toString(36).slice(2)}`;

    return {
      sessionId,
      createdAt: Date.now(),
    };
  }

  function withRuntimeMetadata(
    state: AgentState,
    runtime: SnapshotRuntime
  ): AgentState {
    return {
      ...state,
      sessionId: runtime.sessionId,
      createdAt: runtime.createdAt,
    };
  }

  function getInitialState(...args: [input?: unknown]): AgentState {
    const input = args[0];

    let validatedInput = input;
    if (cfg.schemas?.input) {
      validatedInput = validateSchemaSync(cfg.schemas.input, input);
    }

    const context = cfg.context(validatedInput);
    const init = resolveInitial(cfg.initial, { context, input: {} });

    if (!init.target) {
      throw new Error('Initial transition must specify a target state');
    }

    return {
      value: init.target,
      context: init.context ? { ...context, ...init.context } : context,
      status: 'active',
      input: init.input ? { [init.target]: init.input } : {},
    };
  }

  function resolveState(raw: {
    value: string;
    context: Record<string, unknown>;
    input?: Record<string, Record<string, unknown>>;
    sessionId?: string;
    createdAt?: number;
    status?: AgentState['status'];
    output?: unknown;
    error?: unknown;
  }): AgentState {
    return {
      value: raw.value,
      context: raw.context,
      status: raw.status ?? 'active',
      input: raw.input ?? {},
      sessionId: raw.sessionId,
      createdAt: raw.createdAt,
      output: raw.output,
      error: raw.error,
    };
  }

  function transition(
    state: AgentState,
    event: { type: string; [k: string]: unknown }
  ): AgentState {
    return transitionWithEffects(state, event).next;
  }

  function transitionWithEffects(
    state: AgentState,
    event: { type: string; [k: string]: unknown },
    onEmit?: (part: EmittedPart) => void
  ): { next: AgentState; emitted: EmittedPart[] } {
    const emitted: EmittedPart[] = [];
    const enqueue = createEnqueue((part) => {
      emitted.push(part);
      onEmit?.(part);
    });
    const sc = resolveStateConfig(cfg, state.value);
    function applyResult(
      result: TransitionResult,
      status = state.status
    ): AgentState {
      if (result.target) {
        return applyTransition(state, result);
      }

      return {
        ...state,
        status,
        context: result.context
          ? { ...state.context, ...result.context }
          : state.context,
      };
    }

    function resolveHandlerResult(
      handler:
        | TransitionResult
        | ((args: {
            event: { type: string; [k: string]: unknown };
            context: Record<string, unknown>;
          }, enq: { emit(part: EmittedPart): void }) => TransitionResult),
      status = state.status
    ): { next: AgentState; emitted: EmittedPart[] } {
      const result: TransitionResult =
        typeof handler === 'function'
          ? handler({ context: state.context, event }, enqueue)
          : handler;

      return {
        next: applyResult(result, status),
        emitted,
      };
    }

    if (isDoneInvokeEventType(state.value, event.type)) {
      const result = 'output' in event ? event.output : undefined;
      const validatedResult = sc.resultSchema
        ? validateSchemaSync(sc.resultSchema, result)
        : result;

      if (sc.onDone) {
        const trans = sc.onDone({
          result: validatedResult,
          context: state.context,
        });

        return {
          next: applyResult(trans, 'pending'),
          emitted,
        };
      }

      const internalHandler = sc.on?.[event.type];
      if (internalHandler !== undefined) {
        return resolveHandlerResult(internalHandler, 'pending');
      }

      return { next: { ...state, status: 'pending' }, emitted };
    }

    if (isErrorInvokeEventType(state.value, event.type)) {
      const internalHandler = sc.on?.[event.type];
      if (internalHandler !== undefined) {
        return resolveHandlerResult(internalHandler);
      }

      return {
        next: {
          ...state,
          status: 'error',
          error: 'error' in event ? event.error : undefined,
        },
        emitted,
      };
    }

    validateEventPayload(state.value, event);

    if (sc.on?.[event.type] !== undefined) {
      const handler = sc.on[event.type]!;
      return resolveHandlerResult(handler);
    }

    throw new Error(
      `No handler for event '${event.type}' in state '${state.value}'`
    );
  }

  function validateReplayableResult(
    value: string,
    result: unknown
  ): unknown {
    const sc = resolveStateConfig(cfg, value);
    if (!sc.resultSchema) {
      return result;
    }

    return validateSchemaSync(sc.resultSchema, result);
  }

  function validateEventPayload(
    value: string,
    event: { type: string }
  ): void {
    const schema = findEventSchema(cfg, value, event.type);
    if (!schema) return;
    const result = schema['~standard'].validate(event);
    if (result instanceof Promise) return;
    if (
      result &&
      typeof result === 'object' &&
      'issues' in result &&
      result.issues
    ) {
      const messages = formatSchemaIssues(
        result.issues as Array<{ message: string }>
      );
      throw new Error(`Invalid event '${event.type}': ${messages}`);
    }
  }

  function toInvokeErrorEvent(
    state: AgentState,
    error: unknown
  ): JournalEvent {
    return {
      type: `xstate.error.invoke.${state.value}`,
      error: serializeError(error),
      at: Date.now(),
    };
  }

  function validateEmittedPart(part: EmittedPart): void {
    const schema = findEmittedSchema(cfg, part.type);
    if (!schema) {
      return;
    }

    const result = schema['~standard'].validate(part);
    if (result instanceof Promise) {
      throw new Error(
        'Async schema validation is not supported in sync context.'
      );
    }

    if (result.issues) {
      const messages = formatSchemaIssues(result.issues);
      throw new Error(`Invalid emitted part '${part.type}': ${messages}`);
    }
  }

  function createEnqueue(onEmit?: (part: EmittedPart) => void) {
    return {
      emit(part: EmittedPart) {
        validateEmittedPart(part);
        onEmit?.(part);
      },
    };
  }

  async function createChoiceEvent(state: AgentState): Promise<JournalEvent> {
    const sc = resolveStateConfig(cfg, state.value);
    const adapter = sc.adapter ?? cfg.adapter;
    if (!adapter) {
      return {
        type: `xstate.error.invoke.${state.value}`,
        error: { message: `No adapter for '${state.value}'` },
        at: Date.now(),
      };
    }

    const input = getInput(state.value, state.input);
    const prompt =
      typeof sc.prompt === 'function'
        ? sc.prompt({ context: state.context, input })
        : sc.prompt;

    try {
      const result = await adapter.decide({
        model: sc.model!,
        prompt: prompt as string,
        options: sc.options!,
        reasoning: sc.reasoning,
      });
      const validatedResult = validateReplayableResult(state.value, result);

      return {
        type: `xstate.done.invoke.${state.value}`,
        output: validatedResult,
        at: Date.now(),
      };
    } catch (error) {
      return {
        type: `xstate.error.invoke.${state.value}`,
        error: serializeError(error),
        at: Date.now(),
      };
    }
  }

  async function createInvokeEvent(
    state: AgentState,
    sc: StateConfigAny,
    onEmit?: (part: EmittedPart) => void
  ): Promise<JournalEvent> {
    try {
      const result = await sc.invoke!(
        {
          context: state.context,
          input: getInput(state.value, state.input),
        },
        createEnqueue(onEmit)
      );
      const validatedResult = validateReplayableResult(state.value, result);

      return {
        type: `xstate.done.invoke.${state.value}`,
        output: validatedResult,
        at: Date.now(),
      };
    } catch (error) {
      return {
        type: `xstate.error.invoke.${state.value}`,
        error: serializeError(error),
        at: Date.now(),
      };
    }
  }

  async function getEffectEvent(
    state: AgentState,
    onEmit?: (part: EmittedPart) => void
  ): Promise<JournalEvent | null> {
    if (state.status === 'done' || state.status === 'error') {
      return null;
    }

    const sc = resolveStateConfig(cfg, state.value);
    if (sc.type === 'choice') {
      return createChoiceEvent(state);
    }

    if (sc.invoke) {
      return createInvokeEvent(state, sc, onEmit);
    }

    return null;
  }

  function resolveEffectTransition(
    state: AgentState,
    effectEvent: JournalEvent,
    onEmit?: (part: EmittedPart) => void
  ): { event: JournalEvent; next: AgentState } {
    try {
      return {
        event: effectEvent,
        next: transitionWithEffects(state, effectEvent, onEmit).next,
      };
    } catch (error) {
      if (isDoneInvokeEventType(state.value, effectEvent.type)) {
        const errorEvent = toInvokeErrorEvent(state, error);

        return {
          event: errorEvent,
          next: transitionWithEffects(state, errorEvent, onEmit).next,
        };
      }

      throw error;
    }
  }

  async function invoke(state: AgentState): Promise<AgentState> {
    if (state.status === 'done' || state.status === 'error') {
      return state;
    }

    const sc = resolveStateConfig(cfg, state.value);

    if (sc.type === 'final') {
      const rawOutput = sc.output
        ? sc.output({ context: state.context })
        : undefined;
      const output = cfg.schemas?.output
        ? validateSchemaSync(cfg.schemas.output, rawOutput)
        : rawOutput;
      return { ...state, status: 'done', output };
    }

    const effectEvent = await getEffectEvent(state);
    if (effectEvent) {
      return resolveEffectTransition(state, effectEvent).next;
    }

    if (sc.on) {
      return { ...state, status: 'pending' };
    }

    return {
      ...state,
      status: 'error',
      error: `State '${state.value}' has no invoke, events, or final type`,
    };
  }

  async function execute(state: AgentState): Promise<ExecuteResult> {
    let current = state;
    while (current.status === 'active') {
      current = await invoke(current);
    }

    switch (current.status) {
      case 'done':
        return {
          status: 'done',
          state: current,
          output: current.output,
          context: current.context,
        };
      case 'pending':
        return {
          status: 'pending',
          state: current,
          value: current.value,
          events: getAvailableEvents(cfg, current.value),
          context: current.context,
        };
      case 'error':
        return {
          status: 'error',
          state: current,
          error: current.error,
        };
      default:
        return {
          status: 'error',
          state: current,
          error: `Unexpected: ${current.status}`,
        };
    }
  }

  async function* stream(
    state: AgentState
  ): AsyncGenerator<AgentSnapshot> {
    let current = state;
    const runtime = createSnapshotRuntime(current);
    current = withRuntimeMetadata(current, runtime);
    yield toSnap(current, runtime);
    while (current.status === 'active') {
      current = await invoke(current);
      current = withRuntimeMetadata(current, runtime);
      yield toSnap(current, runtime);
    }
  }

  function toSnap(
    s: AgentState,
    runtime: { sessionId: string; createdAt: number }
  ): AgentSnapshot {
    return {
      value: s.value,
      context: s.context,
      status: s.status,
      sessionId: runtime.sessionId,
      createdAt: runtime.createdAt,
      input: s.input,
      output: s.output,
      error: s.error,
    };
  }

  return {
    id: cfg.id,
    __config: cfg,
    getInitialState,
    resolveState,
    transition,
    invoke,
    execute,
    stream,
    __runtime: {
      toSnapshot: toSnap,
      withRuntimeMetadata,
      getEffectEvent,
      resolveEffectTransition,
      transitionWithEffects,
    },
  } as AgentMachine;
}
