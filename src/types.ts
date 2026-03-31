// ─── Standard Schema compatibility ───
// Minimal Standard Schema V1 interface so any compliant library (zod, valibot, arktype) works.

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

// ─── Events ───

export interface AgentEvent {
  type: string;
  [key: string]: unknown;
}

// ─── Transition ───

export interface TransitionResult {
  target?: string;
  context?: Record<string, unknown>;
  params?: Record<string, unknown>;
}

export interface TransitionArgs<
  TContext = Record<string, unknown>,
  TEvent extends AgentEvent = AgentEvent,
> {
  context: TContext;
  event: TEvent;
}

export interface OnDoneArgs<
  TContext = Record<string, unknown>,
  TResult = unknown,
> {
  result: TResult;
  context: TContext;
}

export interface RunArgs<TContext = Record<string, unknown>> {
  context: TContext;
  parentParams: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface OutputArgs<TContext = Record<string, unknown>> {
  context: TContext;
}

// ─── Decide / Classify ───

export interface DecideResult {
  choice: string;
  data: Record<string, unknown>;
  reasoning?: string;
}

export interface ClassifyResult {
  category: string;
}

export interface DecideConfig {
  model: string;
  adapter?: AgentAdapter;
  prompt:
    | string
    | ((args: {
        context: Record<string, unknown>;
        parentParams: Record<string, unknown>;
      }) => string);
  options: Record<
    string,
    { description: string; schema?: StandardSchemaV1 }
  >;
  reasoning?: boolean;
  onDone: (args: OnDoneArgs<Record<string, unknown>, DecideResult>) => TransitionResult;
  on?: Record<
    string,
    (args: TransitionArgs) => TransitionResult
  >;
}

export interface ClassifyConfig {
  model: string;
  adapter?: AgentAdapter;
  prompt:
    | string
    | ((args: {
        context: Record<string, unknown>;
        parentParams: Record<string, unknown>;
      }) => string);
  into: Record<string, { description: string }>;
  examples?: Array<{ input: string; category: string }>;
  onDone: (
    args: OnDoneArgs<Record<string, unknown>, ClassifyResult>
  ) => TransitionResult;
  on?: Record<
    string,
    (args: TransitionArgs) => TransitionResult
  >;
}

// ─── State config ───

export interface StateConfig {
  type?: 'final';
  outputSchema?: StandardSchemaV1;
  paramsSchema?: StandardSchemaV1;
  run?: (args: RunArgs) => Promise<unknown>;
  onDone?: (args: OnDoneArgs) => TransitionResult;
  on?: Record<
    string,
    (args: TransitionArgs) => TransitionResult
  >;
  events?: Record<string, StandardSchemaV1>;
  output?: (args: OutputArgs) => unknown;
  // Compound state
  initial?:
    | string
    | ((args: {
        context: Record<string, unknown>;
        parentParams: Record<string, unknown>;
      }) => TransitionResult);
  states?: Record<string, StateConfig>;

  // Internal — set by decide/classify helpers
  /** @internal */
  __type?: 'decide' | 'classify';
  /** @internal */
  __decideConfig?: DecideConfig;
  /** @internal */
  __classifyConfig?: ClassifyConfig;
}

// ─── Machine config ───

export interface MachineConfig {
  id: string;
  inputSchema?: StandardSchemaV1;
  context: (input: any) => Record<string, unknown>;
  contextSchema?: StandardSchemaV1;
  events?: Record<string, StandardSchemaV1>;
  adapter?: AgentAdapter;
  initial:
    | string
    | ((args: { context: Record<string, unknown> }) => TransitionResult);
  states: Record<string, StateConfig>;
}

// ─── Agent Machine (returned by createAgentMachine) ───

export interface AgentMachine extends MachineConfig {}

// ─── Agent State (serializable) ───

export interface AgentState {
  value: string;
  params: Record<string, Record<string, unknown>>;
  context: Record<string, unknown>;
  status: 'running' | 'waiting' | 'done' | 'error';
  output?: unknown;
  error?: unknown;
}

// ─── Run result (discriminated union) ───

export type AgentRunResult =
  | {
      status: 'done';
      state: AgentState;
      output: unknown;
      context: Record<string, unknown>;
    }
  | {
      status: 'waiting';
      state: AgentState;
      value: string;
      events: Record<string, StandardSchemaV1>;
      context: Record<string, unknown>;
    }
  | {
      status: 'error';
      state: AgentState;
      error: unknown;
    };

// ─── Snapshot (for streaming) ───

export interface AgentSnapshot {
  value: string;
  context: Record<string, unknown>;
  status: AgentState['status'];
  params: Record<string, Record<string, unknown>>;
}

// ─── Trace ───

export interface Trace {
  state: string;
  event: {
    type: string;
    timestamp: number;
    [key: string]: unknown;
  };
}
