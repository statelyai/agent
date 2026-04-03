import type {
  AgentMachine,
  AgentSnapshot,
  AgentState,
  ExecuteResult,
  MachineConfig,
  StandardSchemaV1,
  StateConfig,
  StateValue,
  TransitionEvent,
  TransitionResult,
} from './types.js';
import {
  applyTransition,
  enterCompoundStates,
  findEventSchema,
  getAvailableEvents,
  getParentConfig,
  getParams,
  pathToValue,
  resolveInitial,
  resolveStateConfig,
  validateSchemaSync,
  valueToPath,
} from './utils.js';

import type { InternalState } from './utils.js';

function toInternal(state: AgentState): InternalState {
  return { ...state, value: valueToPath(state.value) };
}

function toExternal(state: InternalState): AgentState {
  return { ...state, value: pathToValue(state.value) };
}

// Per-state node config with typed params via TParamsMap[K]
type StateNodeDef<TContext extends Record<string, unknown>, TParams> = {
  type?: 'final' | 'choice';
  paramsSchema?: StandardSchemaV1<TParams>;
  invoke?: (args: {
    context: TContext;
    params: NoInfer<TParams>;
    signal?: AbortSignal;
  }) => Promise<unknown>;
  onDone?: (args: { result: any; context: TContext }) => TransitionResult;
  on?: Record<string, (args: { event: any; context: TContext }) => TransitionResult>;
  events?: Record<string, StandardSchemaV1>;
  output?: (args: { context: TContext }) => unknown;
  initial?: string | ((args: { context: TContext; params: Record<string, unknown> }) => TransitionResult);
  states?: Record<string, StateConfig<TContext>>;
  // choice-specific
  model?: string;
  adapter?: import('./types.js').AgentAdapter;
  prompt?: string | ((args: { context: TContext; params: NoInfer<TParams> }) => string);
  options?: Record<string, { description: string; schema?: StandardSchemaV1 }>;
  reasoning?: boolean;
  // internal (from decide/classify wrappers)
  __type?: 'decide' | 'classify';
  __decideConfig?: any;
  __classifyConfig?: any;
};

// Mapped states type: each key K gets its own params from TParamsMap[K]
type StatesWithParams<
  TContext extends Record<string, unknown>,
  TParamsMap extends Record<string, any>,
> = {
  [K in keyof TParamsMap]: StateNodeDef<TContext, TParamsMap[K]>;
};

// ─── Overload 1: schemas.context drives TContext ───
export function createAgentMachine<
  TInput,
  TContext extends Record<string, unknown>,
  const TEvents extends Record<string, StandardSchemaV1>,
  const TParamsMap extends Record<string, any>,
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
    | (keyof TParamsMap & string)
    | ((args: { context: NoInfer<TContext> }) => {
        target: keyof TParamsMap & string;
        params?: Record<string, unknown>;
      });
  states: StatesWithParams<NoInfer<TContext>, TParamsMap>;
}): AgentMachine<TInput, TContext, TEvents, StatesWithParams<TContext, TParamsMap>>;

// ─── Overload 2: context() return drives TContext ───
export function createAgentMachine<
  TInput,
  TContext extends Record<string, unknown>,
  const TEvents extends Record<string, StandardSchemaV1>,
  const TParamsMap extends Record<string, any>,
>(config: {
  id: string;
  schemas?: {
    input?: StandardSchemaV1;
    context?: never;
    events?: TEvents;
  };
  context: (input: TInput) => TContext;
  adapter?: import('./types.js').AgentAdapter;
  initial:
    | (keyof TParamsMap & string)
    | ((args: { context: TContext }) => {
        target: keyof TParamsMap & string;
        params?: Record<string, unknown>;
      });
  states: StatesWithParams<TContext, TParamsMap>;
}): AgentMachine<TInput, TContext, TEvents, StatesWithParams<TContext, TParamsMap>>;

// ─── Implementation ───

export function createAgentMachine(
  machineConfig: MachineConfig<any, any, any, any>
): AgentMachine<any, any, any, any> {
  const cfg = machineConfig;

  // ─── getInitialState (sync) ───

  function getInitialState(...args: [input?: unknown]): AgentState {
    const input = args[0];

    let validatedInput = input;
    const inputSchema = cfg.schemas?.input;
    if (inputSchema) {
      validatedInput = validateSchemaSync(inputSchema, input);
    }

    const context = cfg.context(validatedInput);
    const init = resolveInitial(cfg.initial, { context, params: {} });

    if (!init.target) {
      throw new Error('Initial transition must specify a target state');
    }

    let internal: InternalState = {
      value: init.target,
      params: {},
      context: init.context ? { ...context, ...init.context } : context,
      status: 'active',
    };
    if (init.params) {
      internal.params = { [init.target]: init.params };
    }
    internal = enterCompoundStates(cfg, internal as any) as any;
    return toExternal(internal);
  }

  // ─── resolveState ───

  function resolveState(raw: {
    value: StateValue;
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

  // ─── transition (sync) ───

  function transition(state: AgentState, event: { type: string; [k: string]: unknown }): AgentState {
    const internal = toInternal(state);
    validateEventPayload(internal, event);

    const parts = internal.value.split('.');
    for (let i = 1; i <= parts.length; i++) {
      const path = parts.slice(0, i).join('.');
      const stateConfig = resolveStateConfig(cfg, path);

      if (stateConfig.on?.[event.type]) {
        const handler = stateConfig.on[event.type]!;
        const result = handler({ context: internal.context, event });

        if (result.target) {
          return toExternal(
            applyTransition(cfg, internal as any, result, path) as any
          );
        }

        return toExternal({
          ...internal,
          context: result.context
            ? { ...internal.context, ...result.context }
            : internal.context,
        });
      }
    }

    throw new Error(
      `No handler for event '${event.type}' in state '${internal.value}'`
    );
  }

  function validateEventPayload(
    internal: InternalState,
    event: { type: string; [k: string]: unknown }
  ): void {
    const schema = findEventSchema(cfg, internal.value, event.type);
    if (!schema) return;
    const result = schema['~standard'].validate(event);
    if (result instanceof Promise) return;
    if (result && typeof result === 'object' && 'issues' in result && result.issues) {
      const messages = (result.issues as Array<{ message: string }>)
        .map((i) => i.message)
        .join(', ');
      throw new Error(`Invalid event '${event.type}': ${messages}`);
    }
  }

  // ─── invoke (async, one step) ───

  async function invoke(state: AgentState): Promise<AgentState> {
    const internal = toInternal(state);
    if (internal.status === 'done' || internal.status === 'error') {
      return state;
    }
    const result = await invokeInternal(internal);
    return toExternal(result);
  }

  async function invokeInternal(state: InternalState): Promise<InternalState> {
    const stateConfig = resolveStateConfig(cfg, state.value) as any;

    if (stateConfig.type === 'final') {
      return handleFinal(state, stateConfig);
    }
    // type: 'choice' — inline decide config
    if (stateConfig.type === 'choice') {
      return handleChoice(state, stateConfig);
    }
    // decide()/classify() wrapper — __decideConfig set internally
    if (stateConfig.__decideConfig) {
      return handleDecide(state, stateConfig);
    }
    if (stateConfig.invoke) {
      return handleInvoke(state, stateConfig);
    }
    if (stateConfig.on) {
      return { ...state, status: 'pending' };
    }
    if (stateConfig.states && stateConfig.initial) {
      return { ...state, status: 'active' };
    }
    return {
      ...state,
      status: 'error',
      error: `State '${state.value}' has no invoke, events, or children`,
    };
  }

  function handleFinal(state: InternalState, config: any): InternalState {
    const output = config.output
      ? config.output({ context: state.context })
      : undefined;

    const parts = state.value.split('.');
    if (parts.length <= 1) {
      return { ...state, status: 'done', output };
    }

    const parentConfig = getParentConfig(cfg, state.value);
    if (parentConfig?.onDone) {
      const parentPath = parts.slice(0, -1).join('.');
      const trans = parentConfig.onDone({ result: output, context: state.context });
      return applyTransition(cfg, state as any, trans, parentPath) as any;
    }

    return { ...state, status: 'pending' };
  }

  async function handleChoice(state: InternalState, sc: any): Promise<InternalState> {
    const adapter = sc.adapter ?? cfg.adapter;
    if (!adapter) {
      return { ...state, status: 'error', error: `No adapter for choice state '${state.value}'` };
    }

    const params = getParams(state.value, state.params);
    const prompt = typeof sc.prompt === 'function'
      ? sc.prompt({ context: state.context, params })
      : sc.prompt;

    try {
      const result = await adapter.decide({
        model: sc.model,
        prompt,
        options: sc.options,
        reasoning: sc.reasoning,
      });
      const trans = sc.onDone({ result, context: state.context });
      return applyTransition(cfg, state as any, trans, state.value) as any;
    } catch (error) {
      return { ...state, status: 'error', error };
    }
  }

  async function handleDecide(state: InternalState, stateConfig: StateConfig): Promise<InternalState> {
    const dc = (stateConfig as any).__decideConfig!;
    const adapter = dc.adapter ?? cfg.adapter;
    if (!adapter) {
      return { ...state, status: 'error', error: `No adapter for '${state.value}'` };
    }

    const params = getParams(state.value, state.params);
    const prompt = typeof dc.prompt === 'function'
      ? dc.prompt({ context: state.context, params })
      : dc.prompt;

    try {
      const result = await adapter.decide({
        model: dc.model,
        prompt,
        options: dc.options,
        reasoning: dc.reasoning,
      });
      const trans = dc.onDone({ result, context: state.context });
      return applyTransition(cfg, state as any, trans, state.value) as any;
    } catch (error) {
      return { ...state, status: 'error', error };
    }
  }

  async function handleInvoke(state: InternalState, stateConfig: any): Promise<InternalState> {
    try {
      const result = await stateConfig.invoke!({
        context: state.context,
        params: getParams(state.value, state.params),
      });
      if (stateConfig.onDone) {
        const trans = stateConfig.onDone({ result, context: state.context });
        return applyTransition(cfg, state as any, trans, state.value) as any;
      }
      if (stateConfig.on) {
        return { ...state, status: 'pending' };
      }
      return state;
    } catch (error) {
      return { ...state, status: 'error', error };
    }
  }

  // ─── execute ───

  async function execute(state: AgentState): Promise<ExecuteResult> {
    let internal = toInternal(state);
    while (internal.status === 'active') {
      internal = await invokeInternal(internal);
    }
    const ext = toExternal(internal);

    switch (internal.status) {
      case 'done':
        return { status: 'done', state: ext, output: internal.output, context: internal.context };
      case 'pending':
        return {
          status: 'pending',
          state: ext,
          value: ext.value,
          events: getAvailableEvents(cfg, internal.value),
          context: internal.context,
        };
      case 'error':
        return { status: 'error', state: ext, error: internal.error };
      default:
        return { status: 'error', state: ext, error: `Unexpected: ${internal.status}` };
    }
  }

  // ─── stream ───

  async function* stream(state: AgentState): AsyncGenerator<AgentSnapshot> {
    let internal = toInternal(state);
    yield toSnap(internal);
    while (internal.status === 'active') {
      internal = await invokeInternal(internal);
      yield toSnap(internal);
    }
  }

  function toSnap(s: InternalState): AgentSnapshot {
    return { value: pathToValue(s.value), context: s.context, status: s.status, params: s.params };
  }

  return {
    id: cfg.id,
    getInitialState,
    resolveState,
    transition,
    invoke,
    execute,
    stream,
  } as any;
}
