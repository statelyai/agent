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

export type EmittedUnion<T extends Record<string, StandardSchemaV1>> = EventUnion<T>;

export type TransitionEvent<
  TEvents extends Record<string, StandardSchemaV1>,
> = [keyof TEvents & string] extends [never]
  ? { type: string; [key: string]: unknown }
  : EventUnion<TEvents>;

export type EmittedPart = { type: string; [key: string]: unknown };

export type AgentMessage = {
  role: string;
  content: string;
  [key: string]: unknown;
};

export type AgentTools = Record<string, unknown>;

export type AgentToolChoice =
  | string
  | number
  | boolean
  | null
  | readonly unknown[]
  | { [key: string]: unknown };

export type AgentResolverSnapshot<
  TContext extends Record<string, unknown> = Record<string, unknown>,
> = Omit<
  AgentState<TContext>,
  'model' | 'prompt' | 'system' | 'tools' | 'toolChoice'
>;

export type StateResolverArgs<
  TContext extends Record<string, unknown>,
  TInput = Record<string, unknown>,
> = {
  snapshot: AgentResolverSnapshot<TContext>;
  context: TContext;
  messages: AgentMessage[];
  input: TInput;
};

export type ResolvableStateValue<
  TValue,
  TContext extends Record<string, unknown>,
  TInput = Record<string, unknown>,
> =
  | TValue
  | ((args: StateResolverArgs<TContext, TInput>) => TValue);

export interface InvokeEnqueue {
  emit(part: EmittedPart): void;
}

type IsExactlyUnknown<T> = unknown extends T
  ? ([T] extends [unknown] ? true : false)
  : false;

// ─── Session Contract ───

export type { JournalEvent } from './runtime/events.js';
export type { JournalEventRecord, PersistedSnapshot, RunStore } from './runtime/store.js';

// ─── Adapter ───

export interface AgentAdapter {
  generateText?: (options: {
    model?: string;
    system?: string;
    prompt?: string;
    messages: AgentMessage[];
    tools?: AgentTools;
    toolChoice?: unknown;
    outputSchema?: StandardSchemaV1;
  }) => Promise<unknown>;
}

export interface DecideAdapter {
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

export type TransitionResult<
  TContext extends Record<string, unknown> = Record<string, unknown>,
  TTarget extends string = string,
  TInputByTarget extends Record<string, any> = {},
> =
  | {
      target?: undefined;
      context?: Partial<TContext>;
      messages?: AgentMessage[];
      input?: never;
    }
  | {
      [K in TTarget]: {
        target: K;
        context?: Partial<TContext>;
        messages?: AgentMessage[];
      } & (K extends keyof TInputByTarget
        ? IsExactlyUnknown<TInputByTarget[K]> extends true
          ? { input?: never }
          : { input: TInputByTarget[K] }
        : { input?: never })
    }[TTarget];

export interface InitialTransitionResult<
  TContext extends Record<string, unknown> = Record<string, unknown>,
  TTarget extends string = string,
> {
  target: TTarget;
  context?: Partial<TContext>;
  messages?: AgentMessage[];
  input?: Record<string, unknown>;
}

// ─── State Config ───

export interface StateConfig<
  TContext extends Record<string, unknown> = Record<string, unknown>,
  TTarget extends string = string,
  TInputByTarget extends Record<string, any> = {},
> {
  type?: 'final';
  schemas?: {
    input?: StandardSchemaV1;
    output?: StandardSchemaV1;
  };
  invoke?: (args: {
    context: TContext;
    messages: AgentMessage[];
    input: Record<string, unknown>;
    signal?: AbortSignal;
  }, enq: InvokeEnqueue) => Promise<unknown>;
  onDone?: (args: { output: any; context: TContext; messages: AgentMessage[] }) => TransitionResult<TContext, TTarget, TInputByTarget>;
  always?: TransitionResult<TContext, TTarget, TInputByTarget> | ((args: { context: TContext; messages: AgentMessage[]; input: Record<string, unknown> }, enq: InvokeEnqueue) => TransitionResult<TContext, TTarget, TInputByTarget>);
  on?: Record<string, TransitionResult<TContext, TTarget, TInputByTarget> | ((args: { event: any; context: TContext; messages: AgentMessage[] }, enq: InvokeEnqueue) => TransitionResult<TContext, TTarget, TInputByTarget>)>;
  events?: Record<string, StandardSchemaV1>;
  output?: (args: { context: TContext; messages: AgentMessage[] }) => unknown;
  model?: ResolvableStateValue<string, TContext>;
  adapter?: AgentAdapter;
  prompt?: ResolvableStateValue<string, TContext>;
  system?: ResolvableStateValue<string, TContext>;
  tools?: ResolvableStateValue<AgentTools, TContext>;
  toolChoice?: ResolvableStateValue<AgentToolChoice, TContext>;
}

type OutputForState<TState> = TState extends {
  output: (...args: any[]) => infer TOutput;
}
  ? TOutput
  : never;

export type OutputForStates<TStates extends Record<string, unknown>> =
  [OutputForState<TStates[keyof TStates]>] extends [never]
    ? unknown
    : OutputForState<TStates[keyof TStates]>;

// ─── Agent State (POJO) ───

export interface AgentState<
  TContext extends Record<string, unknown> = Record<string, unknown>,
  TValue extends string = string,
  TOutput = unknown,
> {
  value: TValue;
  context: TContext;
  messages: AgentMessage[];
  status: 'active' | 'pending' | 'done' | 'error';
  input: Record<string, Record<string, unknown>>;
  sessionId?: string;
  createdAt?: number;
  output?: TOutput;
  error?: unknown;
  model?: string;
  prompt?: string;
  system?: string;
  tools?: AgentTools;
  toolChoice?: unknown;
}

// ─── Execute Result ───

export type ExecuteResult<
  TContext extends Record<string, unknown> = Record<string, unknown>,
  TValue extends string = string,
  TEvents extends Record<string, StandardSchemaV1> = {},
  TOutput = unknown,
> =
  | { status: 'done'; state: AgentState<TContext, TValue, TOutput>; output: TOutput; context: TContext; messages: AgentMessage[] }
  | { status: 'pending'; state: AgentState<TContext, TValue, TOutput>; value: TValue; events: Record<string, StandardSchemaV1>; context: TContext; messages: AgentMessage[] }
  | { status: 'error'; state: AgentState<TContext, TValue, TOutput>; error: unknown };

// ─── Snapshot ───

export interface AgentSnapshot<
  TContext extends Record<string, unknown> = Record<string, unknown>,
  TValue extends string = string,
  TOutput = unknown,
> {
  value: TValue;
  context: TContext;
  messages: AgentMessage[];
  status: AgentState['status'];
  createdAt: number;
  sessionId: string;
  input: Record<string, Record<string, unknown>>;
  output?: TOutput;
  error?: unknown;
}

// ─── Agent Machine ───

export interface AgentMachine<
  TInput = unknown,
  TContext extends Record<string, unknown> = Record<string, unknown>,
  TEvents extends Record<string, StandardSchemaV1> = {},
  TStates extends Record<string, any> = Record<string, StateConfig<TContext>>,
  TOutput = OutputForStates<TStates>,
  TEmitted extends Record<string, StandardSchemaV1> = {},
> {
  readonly id: string;
  /** @internal */
  readonly __config?: unknown;

  getInitialState(
    ...args: unknown extends TInput ? [input?: TInput] : [input: TInput]
  ): AgentState<TContext, keyof TStates & string, TOutput>;

  resolveState(
    raw:
      | AgentSnapshot<TContext, keyof TStates & string, TOutput>
      | {
          value: string;
          context: TContext;
          messages?: AgentMessage[];
          input?: Record<string, Record<string, unknown>>;
          sessionId?: string;
          createdAt?: number;
          status?: AgentState['status'];
          output?: TOutput;
          error?: unknown;
        }
  ): AgentState<TContext, keyof TStates & string, TOutput>;

  transition(
    state: AgentState<TContext, keyof TStates & string, TOutput>,
    event: TransitionEvent<TEvents>
  ): AgentState<TContext, keyof TStates & string, TOutput>;

  getEvents(
    state:
      | AgentState<TContext, keyof TStates & string, TOutput>
      | AgentSnapshot<TContext, keyof TStates & string, TOutput>
      | (keyof TStates & string)
  ): Record<string, StandardSchemaV1>;

}

export interface AgentRun<
  TContext extends Record<string, unknown> = Record<string, unknown>,
  TValue extends string = string,
  TEvents extends Record<string, StandardSchemaV1> = {},
  TOutput = unknown,
  TEmitted extends Record<string, StandardSchemaV1> = {},
> {
  readonly sessionId: string;
  readonly status: AgentSnapshot<TContext, TValue, TOutput>['status'];
  getSnapshot(): AgentSnapshot<TContext, TValue, TOutput>;
  send(event: TransitionEvent<TEvents>): Promise<void>;
  on<TKey extends keyof TEmitted & string>(
    type: TKey,
    handler: (event: { type: TKey } & EventPayload<InferOutput<TEmitted[TKey]>>) => void
  ): () => void;
  onEmitted(
    handler: (event: EmittedUnion<TEmitted>) => void
  ): () => void;
  onDone(
    handler: (event: {
      output: TOutput;
      snapshot: AgentSnapshot<TContext, TValue, TOutput>;
    }) => void
  ): () => void;
  onError(
    handler: (event: {
      error: unknown;
      snapshot: AgentSnapshot<TContext, TValue, TOutput>;
    }) => void
  ): () => void;
  onSnapshot(
    handler: (snapshot: AgentSnapshot<TContext, TValue, TOutput>) => void
  ): () => void;
  onMachineEvent(
    handler: (
      event: import('./runtime/store.js').JournalEventRecord<
        import('./runtime/events.js').JournalEvent
      >
    ) => void
  ): () => void;
}

export interface SessionOptions<
  TInput = unknown,
  TSnapshot extends AgentSnapshot = AgentSnapshot,
> {
  input?: TInput;
  sessionId?: string;
  store: import('./runtime/store.js').RunStore<TSnapshot>;
}

export interface RestoreSessionOptions<
  TSnapshot extends AgentSnapshot = AgentSnapshot,
> {
  sessionId: string;
  store: import('./runtime/store.js').RunStore<TSnapshot>;
}

// ─── Machine Config (internal) ───

export interface MachineConfig<
  TInput = unknown,
  TContext extends Record<string, unknown> = Record<string, unknown>,
  TEvents extends Record<string, StandardSchemaV1> = {},
  TStates extends Record<string, any> = Record<string, StateConfig<TContext>>,
  TEmitted extends Record<string, StandardSchemaV1> = {},
> {
  id: string;
  schemas?: {
    input?: StandardSchemaV1;
    context?: StandardSchemaV1;
    events?: TEvents;
    emitted?: TEmitted;
    output?: StandardSchemaV1;
  };
  context: (input: TInput) => TContext;
  messages?: AgentMessage[] | ((input: TInput) => AgentMessage[]);
  adapter?: AgentAdapter;
  externalEvents?: readonly string[];
  initial:
    | (keyof TStates & string)
    | ((args: { context: TContext }) => { target: keyof TStates & string; input?: Record<string, unknown> });
  states: TStates;
}

export type DecideResultFor<
  TOptions extends Record<string, { description: string; schema?: StandardSchemaV1 }>,
> = {
  [K in keyof TOptions & string]: {
    choice: K;
    data: TOptions[K] extends { schema: StandardSchemaV1<infer O> } ? O : Record<string, never>;
    reasoning?: string;
  };
}[keyof TOptions & string];

export interface DecideOptions<
  TOptions extends Record<string, { description: string; schema?: StandardSchemaV1 }> = Record<string, { description: string; schema?: StandardSchemaV1 }>,
> {
  adapter?: DecideAdapter;
  model: string;
  prompt: string;
  options: TOptions;
  reasoning?: boolean;
}

export interface ClassifyResultFor<
  TCategories extends Record<string, { description: string }> = Record<string, { description: string }>,
> {
  category: keyof TCategories & string;
}

export interface ClassifyOptions<
  TCategories extends Record<string, { description: string }> = Record<string, { description: string }>,
> {
  adapter?: DecideAdapter;
  model: string;
  prompt: string;
  into: TCategories;
  examples?: Array<{ input: string; category: keyof TCategories & string }>;
  reasoning?: boolean;
}

// ─── Trace ───

export interface Trace {
  state: string;
  event: { type: string; timestamp: number; [key: string]: unknown };
}
