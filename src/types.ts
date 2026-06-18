export interface StandardSchemaV1<Output = unknown> {
  readonly '~standard': {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => any;
    readonly types?: { readonly input?: unknown; readonly output?: Output };
  };
}

export type InferOutput<T> = T extends StandardSchemaV1<infer O> ? O : never;

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

export interface AgentGenerateTextInput {
  modelRef?: string;
  system?: string;
  prompt?: string;
  messages: AgentMessage[];
  tools?: AgentTools;
  toolChoice?: AgentToolChoice;
  outputSchema?: StandardSchemaV1;
}

export interface AgentAdapter {
  generateText?: (options: AgentGenerateTextInput) => Promise<unknown>;
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

export type DecideResultFor<
  TOptions extends Record<string, { description: string; schema?: StandardSchemaV1 }>,
> = {
  [K in keyof TOptions & string]: {
    choice: K;
    data: TOptions[K] extends { schema: StandardSchemaV1<infer O> }
      ? O
      : Record<string, never>;
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
