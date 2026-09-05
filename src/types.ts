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

/**
 * The *pre*-validation input type of a {@link StandardSchemaV1}: what a caller
 * passes in, before defaults are filled and transforms applied. Standard Schema
 * carries both sides (`~standard.types.input` / `.output`), so a schema
 * declaring a defaulted field makes that field optional here and required in
 * {@link InferOutput} — which is exactly the split between what `runAgent`
 * accepts as machine `input` and what the `context` factory then sees.
 */
export type InferInput<T> = T extends StandardSchemaV1<infer I, any> ? I : never;

/**
 * Phantom brand carrying a machine's declared input schema on the machine type.
 *
 * XState resolves `schemas.input` to a single type and uses it for both
 * `createActor`'s `input` option and the `context: ({ input })` factory, so the
 * caller-facing and factory-facing sides cannot differ there. `setupAgent`'s
 * `createMachine` brands the machine's input type with the schema itself, which
 * lets `AgentInputFrom` recover the looser input side for `runAgent` while the
 * `context` factory keeps the strict validated side.
 *
 * The key is a `~`-prefixed phantom property (the same convention Standard
 * Schema uses for `~standard`) rather than a `unique symbol`: a symbol would
 * have to be exported as a runtime value for declaration emit to name it in
 * every machine type it touches.
 */
export type WithAgentInputSchema<TInputSchema> = {
  readonly "~agent.inputSchema"?: TInputSchema;
};

/** An event schema's output, widened to `unknown` when it validates an empty object (no payload fields). */
export type EventPayload<T> = T extends Record<string, never> ? unknown : T;

/**
 * One entry in an event schema map: a Standard Schema for the event's
 * payload, or the `{}` shorthand for a payload-less event
 * (`events: { CONFIRM: {} }` ≡ `events: { CONFIRM: z.object({}) }`).
 */
export type AgentEventSchemaInput = StandardSchemaV1 | Record<string, never>;

/** An event schema map as authored: payload schemas and/or `{}` payload-less shorthands, keyed by event type. */
export type AgentEventSchemaInputMap = Record<string, AgentEventSchemaInput>;

/** Resolves an authored event schema map's `{}` shorthands to real (empty-payload) schemas — the type-level counterpart of the runtime normalization in `createAgentSchemas`. */
export type NormalizedEventSchemas<T extends AgentEventSchemaInputMap> = {
  [K in keyof T]: T[K] extends StandardSchemaV1 ? T[K] : StandardSchemaV1<{}>;
};

/**
 * The discriminated event union derived from a machine's event schema map
 * (e.g. `{ ASK: z.object({ question: z.string() }) }` → `{ type: 'ASK';
 * question: string }`; a `{}` shorthand entry yields its bare `{ type: K }`).
 * Used internally by {@link createAgentSchemas} and `setupAgent` to type a
 * machine's `TEvent`.
 */
export type EventUnion<T extends AgentEventSchemaInputMap> = {
  [K in keyof T & string]: { type: K } & (T[K] extends StandardSchemaV1
    ? EventPayload<InferOutput<T[K]>>
    : unknown);
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
 * Optional framework-neutral message helpers. Requests also accept native
 * framework message values directly; core never converts between formats.
 * Store messages as plain context state — see {@link appendMessages}.
 */
export type AgentMessage = SystemMessage | UserMessage | AssistantMessage | ToolMessage;

/**
 * A schema value on an {@link AgentToolDescriptor}: deliberately just `object`,
 * because an SDK-native tool's `inputSchema` is the SDK's own union type (a Zod
 * schema, the SDK's `Schema`, a lazy thunk, ...) and must assign structurally
 * with no cast. The contract is runtime, not static: core narrows with
 * `isStandardSchema` and reads {@link StandardSchemaV1} schemas via
 * `getJsonSchema`; anything else passes through to the executor untouched.
 */
export type AgentToolSchema = object;

/**
 * A tool exposed to a text request, described for both the model and
 * (optionally) host execution. This is a **minimal structural contract**: any
 * object matching it — an AI SDK `tool({...})`, an MCP-style descriptor, or a
 * hand-written `{ description, inputSchema, execute }` — is a valid entry, and
 * extra properties (`providerOptions`, `toModelOutput`, …) pass through
 * untouched via the index signature. `execute` is typed permissively so a
 * native tool's `(input, options)` executor is structurally assignable; the
 * SDK you built the tool with owns its precise input typing.
 */
export interface AgentToolDescriptor {
  /**
   * Text shown to the model. Typed loosely enough to accept an SDK tool whose
   * description is computed per call (the AI SDK v7 `tool({ description })`
   * accepts a function of the call's context); core never reads it.
   */
  description?: string | ((...args: any[]) => string);
  inputSchema?: AgentToolSchema;
  outputSchema?: AgentToolSchema;
  execute?: (...args: any[]) => unknown;
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
 * Candidate event types for a decision (declared on the `agent.decide`
 * builtin's `allowedEvents` input). A single
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
