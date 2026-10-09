/**
 * The TanStack AI adapter: builds the `{ generateText, streamText, decide }`
 * executor set consumed by `createAgentRuntime`/`executeAgentRequest`, mapped
 * onto TanStack AI's `chat()` activity and any text adapter
 * (`openaiText(...)`, `anthropicText(...)`, `geminiText(...)`, …).
 *
 * `@tanstack/ai` is an OPTIONAL peer dependency, imported only here. No
 * provider package (`@tanstack/ai-openai`, …) is a dependency: the host passes
 * its own text adapters. Compare `@statelyai/agent/ai-sdk`, the same contract
 * over the Vercel AI SDK.
 */
import {
  chat,
  maxIterations,
  type AnyTextAdapter,
  type ContentPart,
  type ModelMessage,
  type StreamChunk,
  type TokenUsage,
  type Tool,
} from "@tanstack/ai";
import type { TextActivityOptions } from "@tanstack/ai/adapters";
import {
  AGENT_USAGE_TOKEN_FIELDS,
  getAgentOutputMode,
  parseProviderOutput,
  providerOutputSchema,
  type AgentCallUsage,
  type AgentFinishReason,
  type AgentRequestExecutorInfo,
  type AgentTextRequest,
} from "../text-logic.js";
import { AgentTruncatedError } from "../errors.js";
import { renderDecisionAttempts, type AgentDecisionRequest } from "../decision.js";
import type { AgentEventDescriptor } from "../events.js";
import type {
  AgentMessage,
  AgentTool,
  AgentToolChoice,
  AgentTools,
  ChosenEvent,
  DataContent,
  ToolResultPart,
} from "../types.js";
import { getJsonSchema, getJsonSchemaSync, isStandardSchema } from "../utils.js";

// ─── Request → chat() mapping (pure, unit-testable) ───

/** Thrown for a message part TanStack AI's model messages cannot carry —
 * dropping it would silently change what the model sees. */
function unsupportedPart(role: string, type: string): never {
  throw new Error(
    `createTanStackAiExecutors: a ${role} message part of type '${type}' has no TanStack AI ` +
      "equivalent. Send text, image, tool-call, or tool-result parts, or convert it before the " +
      "request.",
  );
}

/** A `DataContent`/`URL` image as a TanStack AI content source: an http(s)
 * string or `URL` is a `url` source; a `data:` URL, a bare base64 string, and
 * raw bytes are a base64 `data` source. */
function toImagePart(image: DataContent | URL, mediaType: string | undefined): ContentPart {
  const mimeType = mediaType ?? "image/jpeg";
  if (image instanceof URL || (typeof image === "string" && /^https?:/.test(image))) {
    return { type: "image", source: { type: "url", value: String(image) } } as ContentPart;
  }
  if (typeof image === "string") {
    const dataUrl = /^data:([^;,]+)?(?:;base64)?,(.*)$/.exec(image);
    return {
      type: "image",
      source: {
        type: "data",
        value: dataUrl ? dataUrl[2]! : image,
        mimeType: dataUrl?.[1] ?? mimeType,
      },
    } as ContentPart;
  }
  const bytes = image instanceof Uint8Array ? image : new Uint8Array(image);
  const encode = (globalThis as { btoa?: (data: string) => string }).btoa;
  if (!encode) {
    throw new Error(
      "createTanStackAiExecutors: binary image parts need a global `btoa` to base64-encode. " +
        "Pass the image as a URL or a base64 string instead.",
    );
  }
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return {
    type: "image",
    source: { type: "data", value: encode(binary), mimeType },
  } as ContentPart;
}

/** One tool message per `ToolResultPart` — the tool role is one message per result. */
function toToolMessage(part: ToolResultPart): ModelMessage {
  return {
    role: "tool",
    toolCallId: part.toolCallId,
    content:
      part.output.type === "text" || part.output.type === "error-text"
        ? part.output.value
        : JSON.stringify(part.output.value),
  };
}

/**
 * Maps `AgentTextRequest.messages`/`system`/`prompt` onto `chat()`'s
 * `systemPrompts` and `messages`. TanStack AI's model messages have no
 * `system` role — a provider adapter may forward one as a user turn — so every
 * system message, and the request's `system`, becomes a system prompt.
 */
export function toTanStackAiMessages(
  request: Pick<AgentTextRequest, "system" | "prompt"> & { messages?: AgentMessage[] },
): { systemPrompts: string[]; messages: ModelMessage[] } {
  const systemPrompts = request.system ? [request.system] : [];
  if (!request.messages) {
    return { systemPrompts, messages: [{ role: "user", content: request.prompt ?? "" }] };
  }

  const messages = request.messages.flatMap((message): ModelMessage[] => {
    switch (message.role) {
      case "system":
        systemPrompts.push(message.content);
        return [];
      case "user": {
        if (typeof message.content === "string") {
          return [{ role: "user", content: message.content }];
        }
        const content = message.content.map((part): ContentPart => {
          switch (part.type) {
            case "text":
              return { type: "text", content: part.text };
            case "image":
              return toImagePart(part.image, part.mediaType);
            default:
              return unsupportedPart("user", part.type);
          }
        });
        return [{ role: "user", content }];
      }
      case "assistant": {
        if (typeof message.content === "string") {
          return [{ role: "assistant", content: message.content }];
        }
        let text = "";
        const toolCalls: NonNullable<ModelMessage["toolCalls"]> = [];
        // A tool result carried inline on an assistant message becomes a
        // separate tool message after it.
        const trailing: ModelMessage[] = [];
        for (const part of message.content) {
          switch (part.type) {
            case "text":
              text += part.text;
              break;
            case "tool-call":
              toolCalls.push({
                id: part.toolCallId,
                type: "function",
                function: { name: part.toolName, arguments: JSON.stringify(part.input ?? {}) },
              });
              break;
            case "tool-result":
              trailing.push(toToolMessage(part));
              break;
            default:
              unsupportedPart("assistant", part.type);
          }
        }
        return [
          {
            role: "assistant",
            content: text || null,
            ...(toolCalls.length > 0 ? { toolCalls } : {}),
          },
          ...trailing,
        ];
      }
      case "tool":
        return message.content.map(toToolMessage);
    }
  });
  return { systemPrompts, messages };
}

/** A tool `description` may be a string or, for an AI SDK v7 tool, a function
 * of the call's context. TanStack AI tools carry the static form. */
function staticDescription(descriptor: AgentTool): string {
  if (typeof descriptor === "function") {
    return "";
  }
  return typeof descriptor.description === "string" ? descriptor.description : "";
}

/**
 * One TanStack AI tool per `AgentTools` entry. A tool with an `execute` (or a
 * bare function) is a server tool `chat()` runs in its loop; a tool without one
 * is a client tool, so the run stops at its call and hands the call back.
 * Input schemas travel as JSON Schema.
 */
export function toTanStackAiTools(tools: AgentTools): Tool[] {
  return Object.entries(tools).flatMap(([name, descriptor]): Tool[] => {
    if (!descriptor) {
      return [];
    }
    const inputSchema = typeof descriptor === "function" ? undefined : descriptor.inputSchema;
    const execute = typeof descriptor === "function" ? descriptor : descriptor.execute;
    return [
      {
        name,
        description: staticDescription(descriptor),
        inputSchema: (isStandardSchema(inputSchema)
          ? getJsonSchemaSync(inputSchema)
          : undefined) ?? {
          type: "object",
        },
        ...(typeof execute === "function" ? { execute: (input: unknown) => execute(input) } : {}),
      } as Tool,
    ];
  });
}

/** One client tool per candidate decision event: no `execute`, so the run
 * stops at the model's first call — the "tool-per-event" recipe. */
export function toTanStackAiEventTools(events: AgentEventDescriptor[]): Tool[] {
  return events.map(
    (event) =>
      ({
        name: event.toolName,
        description: `Choose the '${event.type}' move.`,
        inputSchema: getJsonSchemaSync(event.inputSchema) ?? { type: "object" },
      }) as Tool,
  );
}

/** The generation settings a text and a decision request share. */
type GenerationSettings = Pick<
  AgentTextRequest,
  "temperature" | "maxOutputTokens" | "topP" | "topK" | "seed" | "stopSequences"
>;

/** Drops keys whose value is `undefined`, so a spread cannot erase what it lands on. */
function defined<T extends object>(settings: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(settings).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

/**
 * Maps the request's portable generation settings and tool choice onto the
 * `modelOptions` of the adapter's provider. TanStack AI has no portable
 * sampling or tool-choice options — each provider adapter names its own — so
 * the mapping is per provider (`adapter.name`):
 *
 * - `openai` (Responses API): `temperature`, `top_p`, `max_output_tokens`,
 *   `tool_choice`. The API has no `top_k`, `seed`, or `stop`; those are dropped.
 * - `anthropic`: `temperature`, `top_p`, `top_k`, `max_tokens`,
 *   `stop_sequences`, `tool_choice`. `seed` is dropped; a `'none'` choice is
 *   not expressible and is dropped.
 * - `gemini`: `temperature`, `topP`, `topK`, `maxOutputTokens`, `seed`,
 *   `stopSequences`, `toolConfig.functionCallingConfig`.
 *
 * Any other provider gets none of them: map them yourself through the
 * `settings` option, which receives the request.
 */
export function toTanStackAiModelOptions(
  adapter: Pick<AnyTextAdapter, "name">,
  request: GenerationSettings & { toolChoice?: AgentToolChoice },
): Record<string, unknown> {
  const { toolChoice } = request;
  switch (adapter.name) {
    case "openai":
      return defined({
        temperature: request.temperature,
        top_p: request.topP,
        max_output_tokens: request.maxOutputTokens,
        tool_choice:
          typeof toolChoice === "object" ? { type: "function", name: toolChoice.name } : toolChoice,
      });
    case "anthropic":
      return defined({
        temperature: request.temperature,
        top_p: request.topP,
        top_k: request.topK,
        max_tokens: request.maxOutputTokens,
        stop_sequences: request.stopSequences,
        tool_choice:
          typeof toolChoice === "object"
            ? { type: "tool", name: toolChoice.name }
            : toolChoice === "required"
              ? { type: "any" }
              : toolChoice === "auto"
                ? { type: "auto" }
                : undefined,
      });
    case "gemini":
      return defined({
        temperature: request.temperature,
        topP: request.topP,
        topK: request.topK,
        maxOutputTokens: request.maxOutputTokens,
        seed: request.seed,
        stopSequences: request.stopSequences,
        toolConfig:
          toolChoice === undefined
            ? undefined
            : {
                functionCallingConfig:
                  typeof toolChoice === "object"
                    ? { mode: "ANY", allowedFunctionNames: [toolChoice.name] }
                    : { mode: toolChoice === "required" ? "ANY" : toolChoice.toUpperCase() },
              },
      });
    default:
      return {};
  }
}

/**
 * Messages for a decision request, with prior failed `attempts` rendered as
 * appended user messages so retries converge. Mirrors the AI SDK adapter's
 * `toDecisionMessages`.
 */
export function toDecisionMessages(
  request: Pick<AgentDecisionRequest, "system" | "messages" | "prompt" | "events" | "attempts">,
): { systemPrompts: string[]; messages: ModelMessage[] } {
  const mapped = toTanStackAiMessages(request);
  for (const attempt of renderDecisionAttempts(request)) {
    mapped.messages.push({ role: "user", content: attempt.content as string });
  }
  return mapped;
}

// ─── Result mapping ───

/**
 * Folds TanStack AI's `TokenUsage` onto the flat {@link AgentCallUsage} field
 * names core aggregates. A field the provider omitted stays omitted, so it
 * never contributes a `0` to a run's partial sums.
 */
export function toAgentCallUsage(usage: TokenUsage | undefined): AgentCallUsage | undefined {
  if (!usage) {
    return undefined;
  }
  const reasoningTokens = usage.completionTokensDetails?.reasoningTokens;
  const cachedInputTokens = usage.promptTokensDetails?.cachedTokens;
  return defined({
    inputTokens: usage.promptTokens,
    outputTokens: usage.completionTokens,
    totalTokens: usage.totalTokens,
    reasoningTokens,
    cachedInputTokens,
  });
}

/** Adds two model turns' usage together, field by field. A field neither
 * reported stays absent. */
function addUsage(
  total: AgentCallUsage | undefined,
  next: AgentCallUsage | undefined,
): AgentCallUsage | undefined {
  if (!total || !next) {
    return total ?? next;
  }
  const sum: AgentCallUsage = {};
  for (const field of AGENT_USAGE_TOKEN_FIELDS) {
    if (total[field] !== undefined || next[field] !== undefined) {
      sum[field] = (total[field] ?? 0) + (next[field] ?? 0);
    }
  }
  return sum;
}

/**
 * Maps a TanStack AI finish reason onto the portable {@link AgentFinishReason}.
 * Anything unrecognized, including a missing reason, lands on `'other'`.
 */
export function toAgentFinishReason(finishReason: string | null | undefined): AgentFinishReason {
  switch (finishReason) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "tool_calls":
      return "tool-calls";
    case "content_filter":
      return "content-filter";
    default:
      return "other";
  }
}

/** A model's tool call, as read off the run's `TOOL_CALL_*` events. */
export type TanStackAiToolCall = { toolCallId: string; toolName: string; input: unknown };

/** What one `chat()` run produced, folded from its chunks. */
type RunSummary = {
  text: string;
  structured: unknown;
  usage: AgentCallUsage | undefined;
  finishReason: AgentFinishReason;
  toolCalls: TanStackAiToolCall[];
  chunks: StreamChunk[];
};

/** A `RUN_ERROR` chunk as the `Error` it reports, `code` included. */
class TanStackAiRunError extends Error {
  code: string | undefined;
  constructor(message: string, code: string | undefined) {
    super(message);
    this.name = "TanStackAiRunError";
    this.code = code;
  }
}

/**
 * Reads a `chat()` stream to the end. Text arrives as `TEXT_MESSAGE_CONTENT`
 * deltas; every model turn ends in its own `RUN_FINISHED`, so a tool loop's
 * usage is summed and the last finish reason wins. A provider failure arrives
 * as a `RUN_ERROR` chunk rather than a throw, and is thrown here.
 */
async function readRun(
  stream: AsyncIterable<StreamChunk>,
  onDelta?: (delta: string) => void,
): Promise<RunSummary> {
  const summary: RunSummary = {
    text: "",
    structured: undefined,
    usage: undefined,
    finishReason: "other",
    toolCalls: [],
    chunks: [],
  };
  const args = new Map<string, { toolName: string; json: string }>();
  for await (const chunk of stream) {
    summary.chunks.push(chunk);
    switch (chunk.type) {
      case "TEXT_MESSAGE_CONTENT":
        summary.text += chunk.delta;
        onDelta?.(chunk.delta);
        break;
      case "TOOL_CALL_START":
        args.set(chunk.toolCallId, { toolName: chunk.toolCallName, json: "" });
        break;
      case "TOOL_CALL_ARGS": {
        const call = args.get(chunk.toolCallId);
        if (call) call.json += chunk.delta;
        break;
      }
      case "CUSTOM":
        if (chunk.name === "structured-output.complete") {
          summary.structured = (chunk.value as { object?: unknown } | undefined)?.object;
        }
        break;
      case "RUN_FINISHED": {
        // In process, the finish reason rides on `metadata.tanstack`.
        const finishReason =
          chunk.finishReason ??
          (chunk.metadata?.tanstack as { finishReason?: string | null } | undefined)?.finishReason;
        summary.finishReason = toAgentFinishReason(finishReason);
        if (chunk.usage && !Array.isArray(chunk.usage)) {
          summary.usage = addUsage(summary.usage, toAgentCallUsage(chunk.usage));
        }
        break;
      }
      case "RUN_ERROR":
        throw new TanStackAiRunError(chunk.message, chunk.code ?? chunk.error?.code);
    }
  }
  summary.toolCalls = [...args].map(([toolCallId, call]) => ({
    toolCallId,
    toolName: call.toolName,
    input: call.json ? JSON.parse(call.json) : {},
  }));
  return summary;
}

// ─── createTanStackAiExecutors ───

/**
 * Per-call `chat()` options a host can apply on top of what the machine asked
 * for — provider `modelOptions` (reasoning effort, …), `middleware`,
 * `metadata`, `debug`, and anything else `chat()` accepts. Typed off the
 * installed `@tanstack/ai`, so it tracks that version.
 *
 * The request's own fields are excluded: messages, system prompts, tools,
 * output schema, streaming, cancellation, and the tool-loop bound belong to the
 * machine and the adapter.
 */
export type TanStackAiCallSettings = Omit<
  TextActivityOptions<AnyTextAdapter, undefined, boolean>,
  | "adapter"
  | "messages"
  | "systemPrompts"
  | "tools"
  | "outputSchema"
  | "stream"
  | "abortController"
  | "agentLoopStrategy"
>;

/**
 * One entry in a {@link TanStackAiModelMap}: a bare text adapter, or an adapter
 * paired with the {@link TanStackAiCallSettings} that ref always runs with — how
 * a host gives a ref a persona without the machine naming a provider knob.
 */
export type TanStackAiModelEntry =
  | AnyTextAdapter
  | { adapter: AnyTextAdapter; settings?: TanStackAiCallSettings };

/** Model registry: maps model refs (as used in `setupAgent({ models })`) to
 * TanStack AI text adapters, or to `{ adapter, settings }` pairs. */
export type TanStackAiModelMap<TKey extends string = string> = Record<TKey, TanStackAiModelEntry>;

/**
 * Options for {@link createTanStackAiExecutors}: a static `models` map, a
 * `resolveModel` function (refs resolved dynamically), or both —
 * `resolveModel` takes precedence when both are supplied.
 *
 * `settings` carries `chat()` options that are the HOST's business, such as
 * provider `modelOptions`. Pass an object to apply it to every call, or a
 * function to vary it per request (`request.name` is the request's registered
 * key). Precedence is global `settings`, then the model entry's `settings`,
 * then the request's own generation settings (see
 * {@link toTanStackAiModelOptions}); `modelOptions` merge key by key.
 */
export type CreateTanStackAiExecutorsOptions<
  TModels extends TanStackAiModelMap = TanStackAiModelMap,
> = {
  settings?:
    | TanStackAiCallSettings
    | ((request: AgentTextRequest | AgentDecisionRequest) => TanStackAiCallSettings | undefined);
} & (
  | {
      models: TModels;
      resolveModel?: (modelRef: keyof TModels & string) => AnyTextAdapter;
    }
  | {
      models?: TModels;
      resolveModel: (modelRef: string) => AnyTextAdapter;
    }
);

/**
 * Raw result shape from {@link TanStackAiExecutors.generateText} — `result`
 * (the parsed structured object for structured-output requests, or the text
 * otherwise) plus the run metadata. Core reads `result` and `usage`; everything
 * else flows verbatim to `onResult(request, { raw })`.
 */
export type TanStackAiGenerateResult = {
  result: unknown;
  /** The model's reasoning, present only when the request opted in via
   * `includeReasoning` and the model produced it. */
  reasoning?: string;
  /** Token usage summed over every model turn of the run. */
  usage?: AgentCallUsage;
  /** Why the run stopped, normalized to the portable {@link AgentFinishReason}. */
  finishReason: AgentFinishReason;
  /** Every tool call the model made during the run. */
  toolCalls: TanStackAiToolCall[];
  /** Every chunk the run produced, in order. */
  raw: StreamChunk[];
};

/** Raw result shape from {@link TanStackAiExecutors.streamText} — the
 * accumulated text once the stream finishes (deltas are delivered via
 * `onChunk`), plus the run's usage and finish reason. */
export type TanStackAiStreamResult = {
  result: string;
  usage?: AgentCallUsage;
  finishReason: AgentFinishReason;
  raw: StreamChunk[];
};

/** Raw result shape from {@link TanStackAiExecutors.decide} — the chosen event
 * plus the call metadata, delivered per decision attempt to `onResult`. */
export type TanStackAiDecideResult = {
  event: ChosenEvent;
  usage?: AgentCallUsage;
  finishReason: AgentFinishReason;
  raw: StreamChunk[];
};

/** `createTanStackAiExecutors` always populates all three slots, and its
 * results are concretely typed. */
export interface TanStackAiExecutors {
  generateText: (
    request: AgentTextRequest & { tools: AgentTools },
    info?: AgentRequestExecutorInfo,
  ) => Promise<TanStackAiGenerateResult>;
  streamText: (
    request: AgentTextRequest & { tools: AgentTools },
    info?: AgentRequestExecutorInfo,
  ) => Promise<TanStackAiStreamResult>;
  decide: (
    request: AgentDecisionRequest,
    info?: AgentRequestExecutorInfo,
  ) => Promise<TanStackAiDecideResult>;
}

// A `{ adapter, settings }` pair, as opposed to a bare text adapter — which
// carries `kind: 'text'` and no `adapter` property of its own.
function isAdapterWithSettings(
  entry: TanStackAiModelEntry,
): entry is { adapter: AnyTextAdapter; settings?: TanStackAiCallSettings } {
  return "adapter" in entry && !("kind" in entry);
}

/** The text adapter inside a map entry, whichever form it takes. */
export function toTextAdapter(entry: TanStackAiModelEntry): AnyTextAdapter {
  return isAdapterWithSettings(entry) ? entry.adapter : entry;
}

// Builds the AgentTruncatedError thrown when a structured request ran out of
// output tokens: its JSON never completed, so there is nothing to hand a machine.
function truncated(
  request: AgentTextRequest,
  info: AgentRequestExecutorInfo | undefined,
  partialOutput?: unknown,
  cause?: unknown,
): AgentTruncatedError {
  return new AgentTruncatedError(
    `createTanStackAiExecutors: request '${request.name ?? "(unnamed)"}' hit the output token ` +
      "limit — its structured output never completed. Raise `maxOutputTokens`, shorten " +
      "the input, or ask for a smaller output schema.",
    {
      requestName: request.name ?? "(unnamed)",
      ...(info?.requestId !== undefined ? { requestId: info.requestId } : {}),
      ...(partialOutput !== undefined ? { partialOutput } : {}),
      ...(cause !== undefined ? { cause } : {}),
    },
  );
}

// TanStack AI reports a structured run cut off by the token limit as an error
// rather than a finish reason: `max_tokens` from the engine, or OpenAI's
// Responses `incomplete`, whose message is `max_output_tokens`.
function isTruncationError(error: unknown): boolean {
  const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
  return code === "max_tokens" || code === "incomplete" || message === "max_output_tokens";
}

// The `usage` key, present only when the run reported one.
function usageField(usage: AgentCallUsage | undefined): { usage?: AgentCallUsage } {
  return usage ? { usage } : {};
}

/** `chat()` takes an `AbortController`, not a signal: bridge the runtime's. */
function abortControllerFor(signal: AbortSignal | undefined): AbortController | undefined {
  if (!signal) {
    return undefined;
  }
  const controller = new AbortController();
  if (signal.aborted) {
    controller.abort(signal.reason);
  } else {
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  return controller;
}

/** An aborted `chat()` stream just ends, so surface the abort as the throw it is. */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason ?? new Error("createTanStackAiExecutors: the request was aborted.");
  }
}

/**
 * Builds the `{ generateText, streamText, decide }` executor set over TanStack
 * AI's `chat()`. Compare `createAiSdkExecutors` — same shape, different SDK
 * underneath.
 *
 * - Structured output uses `chat({ outputSchema })` around the
 *   `{ result, reasoning? }` provider output schema.
 * - Tools run in `chat()`'s own loop, for `generateText` and `streamText`
 *   alike, bounded by the request's `maxSteps` (default 1). A tool with no
 *   `execute` stops the run at its call.
 * - Decisions offer one tool per candidate event, with no `execute`, so the
 *   run stops at the model's first call; the tool choice is forced where the
 *   provider supports it (see {@link toTanStackAiModelOptions}).
 *
 * @example
 * ```ts
 * import { openaiText } from '@tanstack/ai-openai';
 *
 * const executors = createTanStackAiExecutors({ models: { quick: openaiText('gpt-5.4-mini') } });
 * const result = await runToQuiescence(createAgentRuntime(machine, { executors }), { input });
 * ```
 */
export function createTanStackAiExecutors<TModels extends TanStackAiModelMap>(
  options: CreateTanStackAiExecutorsOptions<TModels>,
): TanStackAiExecutors {
  // Resolves a request's `model` ref to a text adapter plus the settings that
  // apply to it, merged in precedence order.
  const resolve = (
    request: AgentTextRequest | AgentDecisionRequest,
    portable: GenerationSettings & { toolChoice?: AgentToolChoice },
  ): { adapter: AnyTextAdapter; settings: TanStackAiCallSettings } => {
    let adapter: AnyTextAdapter;
    let entrySettings: TanStackAiCallSettings | undefined;
    if (options.resolveModel) {
      adapter = options.resolveModel(request.model as keyof TModels & string);
    } else {
      const entry = options.models?.[request.model as keyof TModels & string];
      if (!options.models) {
        throw new Error(
          `createTanStackAiExecutors: no model resolver configured for '${request.model}'.`,
        );
      }
      if (!entry) {
        throw new Error(`createTanStackAiExecutors: unknown model '${request.model}'.`);
      }
      adapter = toTextAdapter(entry);
      entrySettings = isAdapterWithSettings(entry) ? entry.settings : undefined;
    }
    const host =
      (typeof options.settings === "function" ? options.settings(request) : options.settings) ?? {};
    return {
      adapter,
      settings: {
        ...host,
        ...entrySettings,
        modelOptions: {
          ...host.modelOptions,
          ...entrySettings?.modelOptions,
          ...toTanStackAiModelOptions(adapter, portable),
        },
      },
    };
  };

  // `maxSteps` bounds the model turns of `chat()`'s tool loop; the default is
  // one, like the AI SDK adapter. A non-finite value would never end a loop
  // that keeps calling tools, so it falls back to the default too.
  const loopBound = (request: AgentTextRequest) =>
    maxIterations(
      typeof request.maxSteps === "number" && Number.isFinite(request.maxSteps)
        ? Math.max(1, Math.floor(request.maxSteps))
        : 1,
    );

  const generateText = async (
    request: AgentTextRequest & { tools: AgentTools },
    info?: AgentRequestExecutorInfo,
  ): Promise<TanStackAiGenerateResult> => {
    const { adapter, settings } = resolve(request, request);
    const tools = toTanStackAiTools(request.tools);
    const structured = getAgentOutputMode(request.outputSchema) === "structured";
    // The structured-output contract (see docs/hosts.md): send the declared
    // schema wrapped as `{ result, reasoning? }`, and return the parsed
    // `result`, which the machine validates against the schema it declared.
    const outputSchema = structured
      ? await getJsonSchema(
          providerOutputSchema(request.outputSchema!, { reasoning: request.includeReasoning }),
        )
      : undefined;

    let run: RunSummary;
    try {
      run = await readRun(
        chat({
          ...settings,
          adapter,
          ...toTanStackAiMessages(request),
          ...(tools.length > 0 ? { tools } : {}),
          ...(outputSchema ? { outputSchema: outputSchema as object, stream: true as const } : {}),
          agentLoopStrategy: loopBound(request),
          abortController: abortControllerFor(info?.signal),
        } as Parameters<typeof chat>[0]) as AsyncIterable<StreamChunk>,
      );
    } catch (error) {
      throw structured && isTruncationError(error)
        ? truncated(request, info, undefined, error)
        : error;
    }
    throwIfAborted(info?.signal);

    if (outputSchema) {
      // A structured output the model DID close, but only because it stopped
      // mid-thought, is not something to hand a machine as a final answer.
      if (run.finishReason === "length") {
        throw truncated(request, info, run.structured ?? run.text);
      }
      const parsed = parseProviderOutput(
        request,
        run.structured !== undefined ? run.structured : JSON.parse(run.text),
      );
      return {
        result: parsed.result,
        ...(typeof parsed.reasoning === "string" ? { reasoning: parsed.reasoning } : {}),
        ...usageField(run.usage),
        finishReason: run.finishReason,
        toolCalls: run.toolCalls,
        raw: run.chunks,
      };
    }

    // A text request that ran out of tokens still has its text. It comes back
    // with `finishReason: 'length'` — the machine decides what that is worth.
    return {
      result: run.text,
      ...usageField(run.usage),
      finishReason: run.finishReason,
      toolCalls: run.toolCalls,
      raw: run.chunks,
    };
  };

  const streamText = async (
    request: AgentTextRequest & { tools: AgentTools },
    info?: AgentRequestExecutorInfo,
  ): Promise<TanStackAiStreamResult> => {
    // A chunk-by-chunk structured object has nothing useful to hand `onChunk`
    // mid-stream, so a structured request is refused rather than silently
    // downgraded to text. Tools run in the loop, as in generateText.
    if (getAgentOutputMode(request.outputSchema) === "structured") {
      throw new Error(
        "createTanStackAiExecutors: streamText streams text — a request declaring a structured " +
          "output schema must be routed to generateText.",
      );
    }

    const { adapter, settings } = resolve(request, request);
    const tools = toTanStackAiTools(request.tools ?? {});
    const run = await readRun(
      chat({
        ...settings,
        adapter,
        ...toTanStackAiMessages(request),
        ...(tools.length > 0 ? { tools } : {}),
        agentLoopStrategy: loopBound(request),
        abortController: abortControllerFor(info?.signal),
      } as Parameters<typeof chat>[0]) as AsyncIterable<StreamChunk>,
      (delta) => info?.onChunk?.(delta),
    );
    throwIfAborted(info?.signal);

    return {
      result: run.text,
      ...usageField(run.usage),
      finishReason: run.finishReason,
      raw: run.chunks,
    };
  };

  const decide = async (
    request: AgentDecisionRequest,
    info?: AgentRequestExecutorInfo,
  ): Promise<TanStackAiDecideResult> => {
    const { adapter, settings } = resolve(request, { ...request, toolChoice: "required" });
    const run = await readRun(
      chat({
        ...settings,
        adapter,
        ...toDecisionMessages(request),
        tools: toTanStackAiEventTools(request.events),
        agentLoopStrategy: maxIterations(1),
        abortController: abortControllerFor(info?.signal),
      } as Parameters<typeof chat>[0]) as AsyncIterable<StreamChunk>,
    );
    throwIfAborted(info?.signal);

    const toolCall = run.toolCalls[0];
    if (!toolCall) {
      throw new Error("createTanStackAiExecutors: decide — model did not call an event tool.");
    }
    const chosenEvent = request.events.find((event) => event.toolName === toolCall.toolName);
    if (!chosenEvent) {
      throw new Error(
        `createTanStackAiExecutors: decide — model called unknown tool '${toolCall.toolName}'.`,
      );
    }

    return {
      // The event's own `type` is spread LAST so it always wins: a stray
      // `type` key in the model's tool input can never override the machine
      // event type.
      event: {
        ...(toolCall.input && typeof toolCall.input === "object" ? toolCall.input : {}),
        type: chosenEvent.type,
      } as ChosenEvent,
      ...usageField(run.usage),
      finishReason: run.finishReason,
      raw: run.chunks,
    };
  };

  return { generateText, streamText, decide };
}
