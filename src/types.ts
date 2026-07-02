export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => any;
    readonly types?: { readonly input: Input; readonly output: Output };
    readonly jsonSchema?: {
      readonly input?: (...args: any[]) => unknown;
      readonly output?: (...args: any[]) => unknown;
    };
  };
}

export type InferOutput<T> = T extends StandardSchemaV1<any, infer O> ? O : never;

export type EventPayload<T> = T extends Record<string, never> ? unknown : T;

export type EventUnion<T extends Record<string, StandardSchemaV1>> = {
  [K in keyof T & string]: { type: K } & EventPayload<InferOutput<T[K]>>;
}[keyof T & string];

export type DataContent = string | Uint8Array | ArrayBuffer;
export type ProviderOptions = Record<string, Record<string, unknown>>;

export interface TextPart {
  type: 'text';
  text: string;
  providerOptions?: ProviderOptions;
}

/**
 * Binary (`Uint8Array`/`ArrayBuffer`) and `URL` values are not
 * JSON-serializable. Machines that persist snapshots/event logs should use
 * URL strings or base64-encoded strings in `image` instead.
 */
export interface ImagePart {
  type: 'image';
  image: DataContent | URL;
  mediaType?: string;
  providerOptions?: ProviderOptions;
}

/**
 * Binary (`Uint8Array`/`ArrayBuffer`) and `URL` values are not
 * JSON-serializable. Machines that persist snapshots/event logs should use
 * URL strings or base64-encoded strings in `data` instead.
 */
export interface FilePart {
  type: 'file';
  data: DataContent | URL;
  mediaType: string;
  filename?: string;
  providerOptions?: ProviderOptions;
}

export interface ToolCallPart {
  type: 'tool-call';
  toolCallId: string;
  toolName: string;
  input: unknown;
  providerOptions?: ProviderOptions;
}

export type ToolResultOutput =
  | { type: 'text'; value: string }
  | { type: 'json'; value: unknown }
  | { type: 'error-text'; value: string }
  | { type: 'error-json'; value: unknown }
  | { type: 'content'; value: Array<TextPart | ImagePart> };

export interface ToolResultPart {
  type: 'tool-result';
  toolCallId: string;
  toolName: string;
  output: ToolResultOutput;
  providerOptions?: ProviderOptions;
}

export type SystemMessage = {
  role: 'system';
  content: string;
  providerOptions?: ProviderOptions;
};
export type UserMessage = {
  role: 'user';
  content: string | Array<TextPart | ImagePart | FilePart>;
  providerOptions?: ProviderOptions;
};
export type AssistantMessage = {
  role: 'assistant';
  content: string | Array<TextPart | FilePart | ToolCallPart | ToolResultPart>;
  providerOptions?: ProviderOptions;
};
export type ToolMessage = {
  role: 'tool';
  content: Array<ToolResultPart>;
  providerOptions?: ProviderOptions;
};

export type AgentMessage =
  | SystemMessage
  | UserMessage
  | AssistantMessage
  | ToolMessage;

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
