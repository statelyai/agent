// ─── Standard Schema V1 ───

export interface StandardSchemaV1<Output = unknown> {
  readonly '~standard': {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => any;
    readonly types?: { readonly input?: unknown; readonly output?: Output };
  };
}

export type StandardSchemaResult<T> =
  | { value: T; issues?: undefined }
  | { value?: undefined; issues: ReadonlyArray<{ message: string }> };

export type InferOutput<T> = T extends StandardSchemaV1<infer O> ? O : never;

// ─── State Value (xstate-style) ───

/** `'idle'` or `{ handling: 'check' }` or `{ a: { b: 'deep' } }` */
export type StateValue = string | { [key: string]: StateValue };

/** Derive the state value union from a states config (depth-limited to 4) */
export type StateValueOf<T> = _SV1<T>;
type _SV1<T> = T extends Record<string, any>
  ? { [K in keyof T & string]: T[K] extends { states: infer S extends Record<string, any> } ? { [P in K]: _SV2<S> } : K }[keyof T & string]
  : never;
type _SV2<T> = T extends Record<string, any>
  ? { [K in keyof T & string]: T[K] extends { states: infer S extends Record<string, any> } ? { [P in K]: _SV3<S> } : K }[keyof T & string]
  : never;
type _SV3<T> = T extends Record<string, any>
  ? { [K in keyof T & string]: K }[keyof T & string]
  : never;

// ─── Event Helpers ───

export type EventPayload<T> = T extends Record<string, never> ? unknown : T;

export type EventUnion<T extends Record<string, StandardSchemaV1>> = {
  [K in keyof T & string]: { type: K } & EventPayload<InferOutput<T[K]>>;
}[keyof T & string];

export type TransitionEvent<
  TEvents extends Record<string, StandardSchemaV1>,
> = [keyof TEvents & string] extends [never]
  ? { type: string; [key: string]: unknown }
  : EventUnion<TEvents>;

// ─── Adapter ───

export interface AgentAdapter {
  decide: (options: {
    model: string;
    prompt: string;
    options: Record<string, { description: string; schema?: StandardSchemaV1 }>;
    reasoning?: boolean;
  }) => Promise<{
    choice: string;
    data: Record<string, unknown>;
    reasoning?: string;
  }>;
}

// ─── Transition ───

export interface TransitionResult {
  target?: string;
  context?: Record<string, unknown>;
  params?: Record<string, unknown>;
}

// ─── State Config ───

export interface StateConfig<
  TContext extends Record<string, unknown> = Record<string, unknown>,
> {
  type?: 'final' | 'choice';
  paramsSchema?: StandardSchemaV1;
  invoke?: (args: {
    context: TContext;
    params: Record<string, unknown>;
    signal?: AbortSignal;
  }) => Promise<unknown>;
  onDone?: (args: { result: any; context: TContext }) => TransitionResult;
  on?: Record<string, string | TransitionResult | ((args: { event: any; context: TContext }) => TransitionResult)>;
  events?: Record<string, StandardSchemaV1>;
  output?: (args: { context: TContext }) => unknown;
  initial?:
    | string
    | ((args: { context: TContext; params: Record<string, unknown> }) => TransitionResult);
  states?: Record<string, StateConfig<TContext>>;
  // choice-specific
  model?: string;
  adapter?: AgentAdapter;
  prompt?: string | ((args: { context: TContext; params: Record<string, unknown> }) => string);
  options?: Record<string, { description: string; schema?: StandardSchemaV1 }>;
  reasoning?: boolean;
  /** @internal */ __type?: 'decide' | 'classify';
  /** @internal */ __decideConfig?: any;
  /** @internal */ __classifyConfig?: any;
}

// ─── Agent State (POJO) ───

export interface AgentState<
  TContext extends Record<string, unknown> = Record<string, unknown>,
  TValue extends StateValue = StateValue,
> {
  value: TValue;
  context: TContext;
  status: 'active' | 'pending' | 'done' | 'error';
  params: Record<string, Record<string, unknown>>;
  output?: unknown;
  error?: unknown;
}

// ─── Execute Result ───

export type ExecuteResult<
  TContext extends Record<string, unknown> = Record<string, unknown>,
  TValue extends StateValue = StateValue,
  TEvents extends Record<string, StandardSchemaV1> = {},
> =
  | { status: 'done'; state: AgentState<TContext, TValue>; output: unknown; context: TContext }
  | { status: 'pending'; state: AgentState<TContext, TValue>; value: TValue; events: Record<string, StandardSchemaV1>; context: TContext }
  | { status: 'error'; state: AgentState<TContext, TValue>; error: unknown };

// ─── Snapshot ───

export interface AgentSnapshot<
  TContext extends Record<string, unknown> = Record<string, unknown>,
  TValue extends StateValue = StateValue,
> {
  value: TValue;
  context: TContext;
  status: AgentState['status'];
  params: Record<string, Record<string, unknown>>;
}

// ─── Agent Machine ───

export interface AgentMachine<
  TInput = unknown,
  TContext extends Record<string, unknown> = Record<string, unknown>,
  TEvents extends Record<string, StandardSchemaV1> = {},
  TStates extends Record<string, any> = Record<string, StateConfig<TContext>>,
> {
  readonly id: string;

  getInitialState(
    ...args: unknown extends TInput ? [input?: TInput] : [input: TInput]
  ): AgentState<TContext, StateValueOf<TStates>>;

  resolveState(raw: {
    value: StateValue;
    context: TContext;
    params?: Record<string, Record<string, unknown>>;
    status?: AgentState['status'];
    output?: unknown;
    error?: unknown;
  }): AgentState<TContext, StateValueOf<TStates>>;

  transition(
    state: AgentState<TContext, StateValueOf<TStates>>,
    event: TransitionEvent<TEvents>
  ): AgentState<TContext, StateValueOf<TStates>>;

  invoke(
    state: AgentState<TContext, StateValueOf<TStates>>
  ): Promise<AgentState<TContext, StateValueOf<TStates>>>;

  execute(
    state: AgentState<TContext, StateValueOf<TStates>>
  ): Promise<ExecuteResult<TContext, StateValueOf<TStates>, TEvents>>;

  stream(
    state: AgentState<TContext, StateValueOf<TStates>>
  ): AsyncGenerator<AgentSnapshot<TContext, StateValueOf<TStates>>>;
}

// ─── Machine Config (internal) ───

export interface MachineConfig<
  TInput = unknown,
  TContext extends Record<string, unknown> = Record<string, unknown>,
  TEvents extends Record<string, StandardSchemaV1> = {},
  TStates extends Record<string, StateConfig<TContext>> = Record<string, StateConfig<TContext>>,
> {
  id: string;
  schemas?: {
    input?: StandardSchemaV1;
    context?: StandardSchemaV1;
    events?: TEvents;
  };
  context: (input: TInput) => TContext;
  adapter?: AgentAdapter;
  initial:
    | (keyof TStates & string)
    | ((args: { context: TContext }) => { target: keyof TStates & string; params?: Record<string, unknown> });
  states: TStates;
}

// ─── Decide (wrapper fn — typed result, untyped context) ───

export type DecideResultFor<
  TOptions extends Record<string, { description: string; schema?: StandardSchemaV1 }>,
> = {
  [K in keyof TOptions & string]: {
    choice: K;
    data: TOptions[K] extends { schema: StandardSchemaV1<infer O> } ? O : Record<string, never>;
    reasoning?: string;
  };
}[keyof TOptions & string];

export interface DecideConfig<
  TOptions extends Record<string, { description: string; schema?: StandardSchemaV1 }> = Record<string, { description: string; schema?: StandardSchemaV1 }>,
> {
  model: string;
  adapter?: AgentAdapter;
  prompt: string | ((args: { context: Record<string, unknown>; params: Record<string, unknown> }) => string);
  options: TOptions;
  reasoning?: boolean;
  onDone: (args: { result: DecideResultFor<TOptions>; context: Record<string, unknown> }) => TransitionResult;
  on?: Record<string, (args: { event: any; context: Record<string, unknown> }) => TransitionResult>;
}

// ─── Classify (wrapper fn — typed category, untyped context) ───

export interface ClassifyConfig<
  TCategories extends Record<string, { description: string }> = Record<string, { description: string }>,
> {
  model: string;
  adapter?: AgentAdapter;
  prompt: string | ((args: { context: Record<string, unknown>; params: Record<string, unknown> }) => string);
  into: TCategories;
  examples?: Array<{ input: string; category: keyof TCategories & string }>;
  onDone: (args: { result: { category: keyof TCategories & string }; context: Record<string, unknown> }) => TransitionResult;
  on?: Record<string, (args: { event: any; context: Record<string, unknown> }) => TransitionResult>;
}

// ─── Trace ───

export interface Trace {
  state: string;
  event: { type: string; timestamp: number; [key: string]: unknown };
}
