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
  getParams,
  isDoneInvokeEventType,
  isErrorInvokeEventType,
  resolveInitial,
  resolveStateConfig,
  serializeError,
  validateSchemaSync,
} from './utils.js';
import type { StateConfigAny } from './utils.js';

// ─── Type helpers ───

type FallbackAny<T> = unknown extends T ? any : T;

/** Choice result shape — always the same for type: 'choice' */
type ChoiceResult = { choice: string; data: Record<string, unknown>; reasoning?: string };

/** Result type for onDone: typed from resultSchema when present */
type OnDoneResult<TResult> = unknown extends TResult ? ChoiceResult : NoInfer<TResult>;

type EventFor<TEvents, E> = E extends keyof TEvents & string
  ? { type: E } & EventPayload<InferOutput<TEvents[E & keyof TEvents]>>
  : { type: E & string; [k: string]: unknown };

type StateNodeDef<
  TContext extends Record<string, unknown>,
  TParams,
  TResult,
  TEvents,
> = {
  type?: 'final' | 'choice';
  paramsSchema?: StandardSchemaV1<TParams>;
  resultSchema?: StandardSchemaV1<TResult>;
  invoke?: (args: {
    context: TContext;
    params: NoInfer<TParams>;
    signal?: AbortSignal;
  }, enq: { emit(part: EmittedPart): void }) => Promise<NoInfer<TResult>>;
  onDone?: (args: { result: OnDoneResult<TResult>; context: TContext }) => TransitionResult<TContext>;
  on?: { [E in keyof TEvents & string]?: TransitionResult<TContext> | ((args: {
      event: EventFor<TEvents, E>;
      context: TContext;
    }) => TransitionResult<TContext>) };
  events?: Record<string, StandardSchemaV1>;
  output?: (args: { context: TContext }) => unknown;
  // choice-specific
  model?: string;
  adapter?: import('./types.js').AgentAdapter;
  prompt?: string | ((args: { context: TContext; params: NoInfer<TParams> }) => string);
  options?: Record<string, { description: string; schema?: StandardSchemaV1 }>;
  reasoning?: boolean;
  // internal
  __type?: 'decide' | 'classify';
  __decideConfig?: Record<string, unknown>;
};

type StatesMap<
  TContext extends Record<string, unknown>,
  TParamsMap extends Record<string, any>,
  TResultMap extends Record<string, any>,
  TEvents,
> = {
  [K in keyof TParamsMap & keyof TResultMap]: StateNodeDef<TContext, TParamsMap[K], TResultMap[K], TEvents>;
};

// ─── Overload A: schemas.context present ───
export function createAgentMachine<
  TInput,
  TContext extends Record<string, unknown>,
  const TEvents extends Record<string, StandardSchemaV1>,
  const TParamsMap extends Record<string, any>,
  TResultMap extends Record<string, any>,
>(config: {
  id: string;
  schemas: {
    context: StandardSchemaV1<TContext>;
    input?: StandardSchemaV1<TInput>;
    events?: TEvents;
    emitted?: Record<string, StandardSchemaV1>;
  };
  context: (input: NoInfer<TInput>) => NoInfer<TContext>;
  adapter?: import('./types.js').AgentAdapter;
  initial:
    | (keyof TParamsMap & keyof TResultMap & string)
    | ((args: { context: NoInfer<TContext> }) => {
        target: keyof TParamsMap & keyof TResultMap & string;
        params?: Record<string, unknown>;
      });
  states: StatesMap<NoInfer<TContext>, TParamsMap, TResultMap, TEvents>;
}): AgentMachine<TInput, TContext, TEvents, StatesMap<TContext, TParamsMap, TResultMap, TEvents>>;

// ─── Overload B: no schemas.context ───
export function createAgentMachine<
  TInput,
  TContext extends Record<string, unknown>,
  const TEvents extends Record<string, StandardSchemaV1>,
  const TParamsMap extends Record<string, any>,
  TResultMap extends Record<string, any>,
>(config: {
  id: string;
  schemas: {
    input: StandardSchemaV1<TInput>;
    context?: never;
    events?: TEvents;
    emitted?: Record<string, StandardSchemaV1>;
  };
  context: (input: NoInfer<TInput>) => TContext;
  adapter?: import('./types.js').AgentAdapter;
  initial:
    | (keyof TParamsMap & keyof TResultMap & string)
    | ((args: { context: TContext }) => {
        target: keyof TParamsMap & keyof TResultMap & string;
        params?: Record<string, unknown>;
      });
  states: StatesMap<TContext, TParamsMap, TResultMap, TEvents>;
}): AgentMachine<TInput, TContext, TEvents, StatesMap<TContext, TParamsMap, TResultMap, TEvents>>;

// ─── Overload C: no schemas.input or schemas.context ───
export function createAgentMachine<
  TContext extends Record<string, unknown>,
  const TEvents extends Record<string, StandardSchemaV1>,
  const TParamsMap extends Record<string, any>,
  TResultMap extends Record<string, any>,
>(config: {
  id: string;
  schemas?: {
    input?: never;
    context?: never;
    events?: TEvents;
    emitted?: Record<string, StandardSchemaV1>;
  };
  context: (...args: any[]) => TContext;
  adapter?: import('./types.js').AgentAdapter;
  initial:
    | (keyof TParamsMap & keyof TResultMap & string)
    | ((args: { context: TContext }) => {
        target: keyof TParamsMap & keyof TResultMap & string;
        params?: Record<string, unknown>;
      });
  states: StatesMap<TContext, TParamsMap, TResultMap, TEvents>;
}): AgentMachine<unknown, TContext, TEvents, StatesMap<TContext, TParamsMap, TResultMap, TEvents>>;

// ─── Implementation ───

export function createAgentMachine(
  machineConfig: MachineConfig<any, any, any, any>
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
    const init = resolveInitial(cfg.initial, { context, params: {} });

    if (!init.target) {
      throw new Error('Initial transition must specify a target state');
    }

    return {
      value: init.target,
      context: init.context ? { ...context, ...init.context } : context,
      status: 'active',
      params: init.params ? { [init.target]: init.params } : {},
    };
  }

  function resolveState(raw: {
    value: string;
    context: Record<string, unknown>;
    params?: Record<string, Record<string, unknown>>;
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
      params: raw.params ?? {},
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
    const sc = resolveStateConfig(cfg, state.value);
    const effectiveConfig = sc.__decideConfig
      ? { ...sc, ...(sc.__decideConfig as Record<string, unknown>) }
      : sc;
    if (isDoneInvokeEventType(state.value, event.type)) {
      const result = 'output' in event ? event.output : undefined;
      const validatedResult = effectiveConfig.resultSchema
        ? validateSchemaSync(effectiveConfig.resultSchema, result)
        : result;

      if (effectiveConfig.onDone) {
        const trans = effectiveConfig.onDone({
          result: validatedResult,
          context: state.context,
        });

        if (trans.target) {
          return applyTransition(state, trans);
        }

        return {
          ...state,
          status: 'pending',
          context: trans.context
            ? { ...state.context, ...trans.context }
            : state.context,
        };
      }

      const internalHandler = sc.on?.[event.type];
      if (internalHandler !== undefined) {
        const result: TransitionResult =
          typeof internalHandler === 'function'
            ? internalHandler({ context: state.context, event })
            : internalHandler;

        if (result.target) {
          return applyTransition(state, result);
        }

        return {
          ...state,
          status: 'pending',
          context: result.context
            ? { ...state.context, ...result.context }
            : state.context,
        };
      }

      return { ...state, status: 'pending' };
    }

    if (isErrorInvokeEventType(state.value, event.type)) {
      const internalHandler = sc.on?.[event.type];
      if (internalHandler !== undefined) {
        const result: TransitionResult =
          typeof internalHandler === 'function'
            ? internalHandler({ context: state.context, event })
            : internalHandler;

        if (result.target) {
          return applyTransition(state, result);
        }

        return {
          ...state,
          context: result.context
            ? { ...state.context, ...result.context }
            : state.context,
        };
      }

      return {
        ...state,
        status: 'error',
        error: 'error' in event ? event.error : undefined,
      };
    }

    validateEventPayload(state.value, event);

    if (sc.on?.[event.type] !== undefined) {
      const handler = sc.on[event.type]!;
      const result: TransitionResult =
        typeof handler === 'function'
          ? handler({ context: state.context, event })
          : handler;

      if (result.target) {
        return applyTransition(state, result);
      }

      return {
        ...state,
        context: result.context
          ? { ...state.context, ...result.context }
          : state.context,
      };
    }

    throw new Error(
      `No handler for event '${event.type}' in state '${state.value}'`
    );
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
    const dc = sc.__decideConfig
      ? { ...sc, ...(sc.__decideConfig as Record<string, unknown>) }
      : sc;
    const adapter = (dc as StateConfigAny).adapter ?? cfg.adapter;
    if (!adapter) {
      return {
        type: `xstate.error.invoke.${state.value}`,
        error: { message: `No adapter for '${state.value}'` },
        at: Date.now(),
      };
    }

    const params = getParams(state.value, state.params);
    const prompt =
      typeof dc.prompt === 'function'
        ? dc.prompt({ context: state.context, params })
        : dc.prompt;

    try {
      const result = await adapter.decide({
        model: (dc as StateConfigAny).model!,
        prompt: prompt as string,
        options: (dc as StateConfigAny).options!,
        reasoning: (dc as StateConfigAny).reasoning,
      });

      return {
        type: `xstate.done.invoke.${state.value}`,
        output: result,
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
          params: getParams(state.value, state.params),
        },
        createEnqueue(onEmit)
      );

      return {
        type: `xstate.done.invoke.${state.value}`,
        output: result,
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
    if (sc.type === 'choice' || sc.__decideConfig) {
      return createChoiceEvent(state);
    }

    if (sc.invoke) {
      return createInvokeEvent(state, sc, onEmit);
    }

    return null;
  }

  async function invoke(state: AgentState): Promise<AgentState> {
    if (state.status === 'done' || state.status === 'error') {
      return state;
    }

    const sc = resolveStateConfig(cfg, state.value);

    if (sc.type === 'final') {
      const output = sc.output
        ? sc.output({ context: state.context })
        : undefined;
      return { ...state, status: 'done', output };
    }

    const effectEvent = await getEffectEvent(state);
    if (effectEvent) {
      return transition(state, effectEvent);
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
      params: s.params,
      output: s.output,
      error: s.error,
    };
  }

  return {
    id: cfg.id,
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
    },
  } as AgentMachine;
}
