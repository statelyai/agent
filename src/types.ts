export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => any;
    readonly types?: { readonly input: Input; readonly output: Output };
  };
}

export type InferOutput<T> = T extends StandardSchemaV1<any, infer O> ? O : never;

export type EventPayload<T> = T extends Record<string, never> ? unknown : T;

export type EventUnion<T extends Record<string, StandardSchemaV1>> = {
  [K in keyof T & string]: { type: K } & EventPayload<InferOutput<T[K]>>;
}[keyof T & string];

export type AgentMessage = {
  role: string;
  content: string;
  [key: string]: unknown;
};

export interface AgentToolDescriptor {
  description?: string;
  inputSchema?: StandardSchemaV1;
  outputSchema?: StandardSchemaV1;
  execute?: AgentToolExecute;
  [key: string]: unknown;
}

export type AgentToolExecute = (input?: unknown) => unknown | Promise<unknown>;

export type AgentTool = AgentToolDescriptor | AgentToolExecute;

export type AgentTools = Record<string, AgentTool | undefined>;

export type AgentToolChoice =
  | 'auto'
  | 'none'
  | 'required'
  | { type: 'tool'; name: string };
