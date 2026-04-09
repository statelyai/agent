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

// ─── Durable Session Vocabulary ───

export type { JournalEvent } from './runtime/events.js';

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

export interface TransitionResult<
  TContext extends Record<string, unknown> = Record<string, unknown>,
> {
  target?: string;
  context?: Partial<TContext>;
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
  onDone?: (args: { result: any; context: TContext }) => TransitionResult<TContext>;
  on?: Record<string, TransitionResult<TContext> | ((args: { event: any; context: TContext }) => TransitionResult<TContext>)>;
  events?: Record<string, StandardSchemaV1>;
  output?: (args: { context: TContext }) => unknown;
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
  TValue extends string = string,
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
  TValue extends string = string,
  TEvents extends Record<string, StandardSchemaV1> = {},
> =
  | { status: 'done'; state: AgentState<TContext, TValue>; output: unknown; context: TContext }
  | { status: 'pending'; state: AgentState<TContext, TValue>; value: TValue; events: Record<string, StandardSchemaV1>; context: TContext }
  | { status: 'error'; state: AgentState<TContext, TValue>; error: unknown };

// ─── Snapshot ───

export interface AgentSnapshot<
  TContext extends Record<string, unknown> = Record<string, unknown>,
  TValue extends string = string,
> {
  value: TValue;
  context: TContext;
  status: AgentState['status'];
  createdAt: number;
  sessionId: string;
  output?: unknown;
  error?: unknown;
}

export type { PersistedSnapshot, RunStore } from './runtime/store.js';

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
  ): AgentState<TContext, keyof TStates & string>;

  resolveState(raw: {
    value: string;
    context: TContext;
    params?: Record<string, Record<string, unknown>>;
    status?: AgentState['status'];
    output?: unknown;
    error?: unknown;
  }): AgentState<TContext, keyof TStates & string>;

  transition(
    state: AgentState<TContext, keyof TStates & string>,
    event: TransitionEvent<TEvents>
  ): AgentState<TContext, keyof TStates & string>;

  invoke(
    state: AgentState<TContext, keyof TStates & string>
  ): Promise<AgentState<TContext, keyof TStates & string>>;

  execute(
    state: AgentState<TContext, keyof TStates & string>
  ): Promise<ExecuteResult<TContext, keyof TStates & string, TEvents>>;

  stream(
    state: AgentState<TContext, keyof TStates & string>
  ): AsyncGenerator<AgentSnapshot<TContext, keyof TStates & string>>;
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

// ─── Decide ───

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
  TContext extends Record<string, unknown> = Record<string, unknown>,
  TParams extends Record<string, unknown> = Record<string, unknown>,
  TOptions extends Record<string, { description: string; schema?: StandardSchemaV1 }> = Record<string, { description: string; schema?: StandardSchemaV1 }>,
> {
  model: string;
  adapter?: AgentAdapter;
  prompt: string | ((args: { context: TContext; params: TParams }) => string);
  options: TOptions;
  reasoning?: boolean;
  onDone: (args: { result: DecideResultFor<TOptions>; context: TContext }) => TransitionResult<TContext>;
  on?: Record<string, (args: { event: any; context: TContext }) => TransitionResult<TContext>>;
}

// ─── Classify ───

export interface ClassifyConfig<
  TContext extends Record<string, unknown> = Record<string, unknown>,
  TParams extends Record<string, unknown> = Record<string, unknown>,
  TCategories extends Record<string, { description: string }> = Record<string, { description: string }>,
> {
  model: string;
  adapter?: AgentAdapter;
  prompt: string | ((args: { context: TContext; params: TParams }) => string);
  into: TCategories;
  examples?: Array<{ input: string; category: keyof TCategories & string }>;
  onDone: (args: { result: { category: keyof TCategories & string }; context: TContext }) => TransitionResult<TContext>;
  on?: Record<string, (args: { event: any; context: TContext }) => TransitionResult<TContext>>;
}

// ─── Trace ───

export interface Trace {
  state: string;
  event: { type: string; timestamp: number; [key: string]: unknown };
}
