import type { Snapshot } from "xstate";

/**
 * A minimal, type-only contract for a snapshot store: persist a `runAgent`
 * idle/settled snapshot under an id and load it back. It exists purely so
 * userland stores (a file, a SQLite table, a KV row, …) share one shape and
 * interoperate — there is **zero runtime** behind it; the library ships no
 * implementation. See `examples/file-snapshot-store` for a `node:fs` store.
 */
export interface AgentSnapshotStore {
  load(id: string): Promise<Snapshot<unknown> | undefined>;
  save(id: string, snapshot: Snapshot<unknown>): Promise<void>;
}

/**
 * The [Standard Schema](https://standardschema.dev) interface. Every schema
 * this library accepts (context, events, input/output, tool schemas, …) is a
 * `StandardSchemaV1` — Zod, Valibot, ArkType, and hand-written validators all
 * implement it, so the library never depends on a specific validation
 * library. JSON workflow configs use a caller-provided {@link SchemaCompiler}.
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": {
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

/** The validated output type of a {@link StandardSchemaV1}. */
export type InferOutput<T> = T extends StandardSchemaV1<any, infer O> ? O : never;

/** An event schema's output, widened to `unknown` when it validates an empty object (no payload fields). */
export type EventPayload<T> = T extends Record<string, never> ? unknown : T;

/**
 * The discriminated event union derived from a machine's event schema map
 * (e.g. `{ ASK: z.object({ question: z.string() }) }` → `{ type: 'ASK';
 * question: string }`). Used internally by {@link createAgentSchemas} and
 * `setupAgent` to type a machine's `TEvent`.
 */
export type EventUnion<T extends Record<string, StandardSchemaV1>> = {
  [K in keyof T & string]: { type: K } & EventPayload<InferOutput<T[K]>>;
}[keyof T & string];

/** Raw binary or string content for an {@link ImagePart}/{@link FilePart}. */
export type DataContent = string | Uint8Array | ArrayBuffer;
/** Provider-specific passthrough options, keyed by provider name (e.g. `{ anthropic: { cacheControl: ... } }`). */
export type ProviderOptions = Record<string, Record<string, unknown>>;

/** A plain-text segment of a multi-part {@link AgentMessage} content array. */
export interface TextPart {
  type: "text";
  text: string;
  providerOptions?: ProviderOptions;
}

/**
 * Binary (`Uint8Array`/`ArrayBuffer`) and `URL` values are not
 * JSON-serializable. Machines that persist snapshots/event logs should use
 * URL strings or base64-encoded strings in `image` instead.
 */
export interface ImagePart {
  type: "image";
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
  type: "file";
  data: DataContent | URL;
  mediaType: string;
  filename?: string;
  providerOptions?: ProviderOptions;
}

/** A model-issued tool call, as an {@link AssistantMessage} content part. */
export interface ToolCallPart {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  input: unknown;
  providerOptions?: ProviderOptions;
}

/** The result payload of a {@link ToolResultPart}, discriminated by shape (plain text/JSON, or an error variant of either). */
export type ToolResultOutput =
  | { type: "text"; value: string }
  | { type: "json"; value: unknown }
  | { type: "error-text"; value: string }
  | { type: "error-json"; value: unknown }
  | { type: "content"; value: Array<TextPart | ImagePart> };

/** A tool's result, as a {@link ToolMessage} content part. */
export interface ToolResultPart {
  type: "tool-result";
  toolCallId: string;
  toolName: string;
  output: ToolResultOutput;
  providerOptions?: ProviderOptions;
}

/** A system-role {@link AgentMessage}. Create with {@link systemMessage}. */
export type SystemMessage = {
  role: "system";
  content: string;
  providerOptions?: ProviderOptions;
};
/** A user-role {@link AgentMessage}, optionally multimodal. Create with {@link userMessage}. */
export type UserMessage = {
  role: "user";
  content: string | Array<TextPart | ImagePart | FilePart>;
  providerOptions?: ProviderOptions;
};
/** An assistant-role {@link AgentMessage}, which may carry tool calls/results inline. Create with {@link assistantMessage}. */
export type AssistantMessage = {
  role: "assistant";
  content: string | Array<TextPart | FilePart | ToolCallPart | ToolResultPart>;
  providerOptions?: ProviderOptions;
};
/** A tool-role {@link AgentMessage} carrying one or more tool results. Create with {@link toolMessage}. */
export type ToolMessage = {
  role: "tool";
  content: Array<ToolResultPart>;
  providerOptions?: ProviderOptions;
};

/**
 * A single conversation turn, in this library's portable message model
 * (structurally compatible with the AI SDK's `ModelMessage`). Stored as
 * plain context state — see {@link appendMessages} — and passed to text/
 * decision requests via `messages`. Validate a context field with
 * {@link messagesSchema}.
 */
export type AgentMessage = SystemMessage | UserMessage | AssistantMessage | ToolMessage;

/** A tool exposed to a text request, described for both the model and (optionally) host execution. */
export interface AgentToolDescriptor {
  description?: string;
  inputSchema?: StandardSchemaV1;
  outputSchema?: StandardSchemaV1;
  execute?: AgentToolExecute;
  [key: string]: unknown;
}

/** A bare tool implementation (no description/schema) — shorthand for {@link AgentToolDescriptor.execute}. */
export type AgentToolExecute = (input?: unknown) => unknown | Promise<unknown>;

/** A tool entry in {@link AgentTools}: either a full descriptor or a bare execute function. */
export type AgentTool = AgentToolDescriptor | AgentToolExecute;

/** The `tools` map passed on an {@link AgentTextRequest}, keyed by tool name. */
export type AgentTools = Record<string, AgentTool | undefined>;

/** How a text request's model should select among its `tools`; `{ type: 'tool', name }` forces one specific tool. */
export type AgentToolChoice = "auto" | "none" | "required" | { type: "tool"; name: string };

/** The event chosen and raised by a decision. */
export type ChosenEvent = { type: string; [key: string]: unknown };

// The wildcard patterns a dotted event-type union admits: 'a.b.c' yields 'a.*' | 'a.b.*'.
type EventWildcardsOf<TEvent extends string> = TEvent extends `${infer Head}.${infer Rest}`
  ? `${Head}.*` | `${Head}.${EventWildcardsOf<Rest>}`
  : never;

/** One `allowedEvents` entry: an exact declared event type, `'*'` (every event), or a `'prefix.*'` wildcard derived from the declared dotted event types. */
export type AllowedEventPattern<TEvent extends string = string> =
  | TEvent
  | "*"
  | EventWildcardsOf<TEvent>;

/**
 * Candidate event types for a decision or plan (declared on the
 * `agent.decide`/`agent.plan` builtins' `allowedEvents` input). A single
 * entry or an array; entries are exact event types or wildcard patterns
 * (`'*'` for every event, `'todo.*'` for a dotted namespace). The effective
 * candidate set offered to the model is this declaration **intersected with
 * the snapshot's currently-legal events** (via `getAcceptedEvents`) —
 * omitting `allowedEvents` means "all currently-legal events." A resolver
 * function can therefore only ever narrow, never widen, the real surface.
 * Wildcards expand against the live snapshot, so they need a snapshot-aware
 * host (`runAgent` or the step path).
 */
export type AllowedEvents<TEvent extends string = string, TInput = unknown> =
  | AllowedEventPattern<TEvent>
  | readonly AllowedEventPattern<TEvent>[]
  | ((args: {
      input: TInput;
    }) => AllowedEventPattern<TEvent> | readonly AllowedEventPattern<TEvent>[]);
