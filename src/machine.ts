import type {
  AgentMachine,
  AgentSnapshot,
  AgentState,
  EventPayload,
  ExecuteResult,
  InferOutput,
  MachineConfig,
  StandardSchemaV1,
  TransitionResult,
} from './types.js';
import {
  applyTransition,
  findEventSchema,
  getAvailableEvents,
  getParams,
  resolveInitial,
  resolveStateConfig,
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
  }) => Promise<NoInfer<TResult>>;
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
  TContext extends Record<string, unknown>,
  const TEvents extends Record<string, StandardSchemaV1>,
  const TParamsMap extends Record<string, any>,
  TResultMap extends Record<string, any>,
>(config: {
  id: string;
  schemas?: {
    input?: StandardSchemaV1;
    context?: never;
    events?: TEvents;
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
    status?: AgentState['status'];
    output?: unknown;
    error?: unknown;
  }): AgentState {
    return {
      value: raw.value,
      context: raw.context,
      status: raw.status ?? 'active',
      params: raw.params ?? {},
      output: raw.output,
      error: raw.error,
    };
  }

  function transition(
    state: AgentState,
    event: { type: string; [k: string]: unknown }
  ): AgentState {
    validateEventPayload(state.value, event);

    const sc = resolveStateConfig(cfg, state.value);
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
      const messages = (result.issues as Array<{ message: string }>)
        .map((i) => i.message)
        .join(', ');
      throw new Error(`Invalid event '${event.type}': ${messages}`);
    }
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

    if (sc.type === 'choice' || sc.__decideConfig) {
      return handleChoice(state, sc);
    }

    if (sc.invoke) {
      return handleInvoke(state, sc);
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

  async function handleChoice(
    state: AgentState,
    sc: StateConfigAny
  ): Promise<AgentState> {
    // Merge __decideConfig props onto sc for decide() wrapper compat
    const dc = sc.__decideConfig
      ? { ...sc, ...(sc.__decideConfig as Record<string, unknown>) }
      : sc;
    const adapter = (dc as StateConfigAny).adapter ?? cfg.adapter;
    if (!adapter) {
      return {
        ...state,
        status: 'error',
        error: `No adapter for '${state.value}'`,
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
      const onDone = (dc as StateConfigAny).onDone;
      if (!onDone) return { ...state, status: 'error', error: 'choice state missing onDone' };
      const trans = onDone({ result, context: state.context });
      return applyTransition(state, trans);
    } catch (error) {
      return { ...state, status: 'error', error };
    }
  }

  async function handleInvoke(
    state: AgentState,
    sc: StateConfigAny
  ): Promise<AgentState> {
    try {
      const result = await sc.invoke!({
        context: state.context,
        params: getParams(state.value, state.params),
      });
      if (sc.onDone) {
        const trans = sc.onDone({ result, context: state.context });
        return applyTransition(state, trans);
      }
      if (sc.on) {
        return { ...state, status: 'pending' };
      }
      return state;
    } catch (error) {
      return { ...state, status: 'error', error };
    }
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
    yield toSnap(current);
    while (current.status === 'active') {
      current = await invoke(current);
      yield toSnap(current);
    }
  }

  function toSnap(s: AgentState): AgentSnapshot {
    return {
      value: s.value,
      context: s.context,
      status: s.status,
      sessionId: cfg.id,
      createdAt: Date.now(),
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
  } as AgentMachine;
}
