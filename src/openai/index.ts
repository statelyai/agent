/**
 * The raw `openai` package adapter: builds the `{ generateText, streamText,
 * decide }` executor set consumed by `createAgentRuntime`/`executeAgentRequest`,
 * with no Vercel AI SDK in between. Calls that carry function tools — every
 * `decide`, and a `generateText` with tools — go through the Responses API,
 * because reasoning models such as `gpt-6-luna` reject function tools on Chat
 * Completions. Tool-free calls stay on Chat Completions.
 *
 * `openai` is an OPTIONAL peer dependency and is imported for TYPES ONLY: the
 * client is injected, so nothing here pulls the package into a bundle at
 * runtime. Compare `@statelyai/agent/ai-sdk`, the same contract over the AI SDK.
 */
import type OpenAI from "openai";
import type {
  ChatCompletion,
  ChatCompletionAssistantMessageParam,
  ChatCompletionChunk,
  ChatCompletionContentPart,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions/completions.js";
import type {
  FunctionTool,
  Response,
  ResponseCreateParamsNonStreaming,
  ResponseFunctionToolCall,
  ResponseInputContent,
  ResponseInputItem,
  ResponseUsage,
} from "openai/resources/responses/responses.js";
import {
  AGENT_USAGE_TOKEN_FIELDS,
  providerOutputSchema,
  getAgentOutputMode,
  parseProviderOutput,
  type AgentCallUsage,
  type AgentFinishReason,
  type AgentRequestExecutorInfo,
  type AgentTextRequest,
} from "../text-logic.js";
import { AgentTruncatedError } from "../errors.js";
import {
  renderDecisionAttempts,
  type AgentDecisionRejection,
  type AgentDecisionRequest,
} from "../decision.js";
import { rejectedAnswer } from "../internal/rejected-answer.js";
import { withModelCalls } from "../internal/with-model-calls.js";
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

// ─── Request → OpenAI param mapping (pure, unit-testable) ───

/** Thrown for a message part Chat Completions cannot carry — dropping it would
 * silently change what the model sees. */
function unsupportedPart(role: string, type: string): never {
  throw new Error(
    `createOpenAiExecutors: a ${role} message part of type '${type}' has no Chat Completions ` +
      "equivalent. Send text, image, tool-call, or tool-result parts, or convert it before the " +
      "request.",
  );
}

/** A `DataContent`/`URL` image as the URL string OpenAI's `image_url` part wants:
 * an http(s) or `data:` string and a `URL` pass through, a bare base64 string and
 * raw bytes are wrapped in a data URL. */
function toImageUrl(image: DataContent | URL, mediaType: string | undefined): string {
  if (image instanceof URL) {
    return image.href;
  }
  const type = mediaType ?? "image/jpeg";
  if (typeof image === "string") {
    return /^(https?:|data:)/.test(image) ? image : `data:${type};base64,${image}`;
  }
  const bytes = image instanceof Uint8Array ? image : new Uint8Array(image);
  const encode = (globalThis as { btoa?: (data: string) => string }).btoa;
  if (!encode) {
    throw new Error(
      "createOpenAiExecutors: binary image parts need a global `btoa` to base64-encode. Pass the " +
        "image as a URL or a base64 string instead.",
    );
  }
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return `data:${type};base64,${encode(binary)}`;
}

/** One OpenAI tool message per `ToolResultPart` — the tool role is one message per result. */
function toToolMessage(part: ToolResultPart): ChatCompletionMessageParam {
  return {
    role: "tool",
    content:
      part.output.type === "text" || part.output.type === "error-text"
        ? part.output.value
        : JSON.stringify(part.output.value),
    tool_call_id: part.toolCallId,
  };
}

/** Maps `AgentTextRequest.messages`/`system`/`prompt` to OpenAI chat messages. */
export function toOpenAiMessages(
  request: Pick<AgentTextRequest, "system" | "prompt"> & { messages?: AgentMessage[] },
): ChatCompletionMessageParam[] {
  if (request.messages) {
    // AgentMessage's `system|user|assistant|tool` roles map 1:1 onto OpenAI's
    // message roles; string content is directly compatible with OpenAI's
    // content union for each role. Multi-part content is mapped part by part,
    // and a part Chat Completions cannot carry throws rather than vanishing.
    return request.messages.flatMap((message): ChatCompletionMessageParam[] => {
      switch (message.role) {
        case "system":
          return [{ role: "system", content: message.content }];
        case "user": {
          if (typeof message.content === "string") {
            return [{ role: "user", content: message.content }];
          }
          const content = message.content.map((part): ChatCompletionContentPart => {
            switch (part.type) {
              case "text":
                return { type: "text", text: part.text };
              case "image":
                return {
                  type: "image_url",
                  image_url: { url: toImageUrl(part.image, part.mediaType) },
                };
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
          const toolCalls: NonNullable<ChatCompletionAssistantMessageParam["tool_calls"]> = [];
          // A tool result carried inline on an assistant message becomes a
          // separate tool message after it — where Chat Completions puts one.
          const trailing: ChatCompletionMessageParam[] = [];
          for (const part of message.content) {
            switch (part.type) {
              case "text":
                text += part.text;
                break;
              case "tool-call":
                toolCalls.push({
                  id: part.toolCallId,
                  type: "function",
                  function: {
                    name: part.toolName,
                    arguments: JSON.stringify(part.input ?? {}),
                  },
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
              content: text,
              ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
            },
            ...trailing,
          ];
        }
        case "tool":
          return message.content.map(toToolMessage);
      }
    });
  }

  const messages: ChatCompletionMessageParam[] = [];
  if (request.system) {
    messages.push({ role: "system", content: request.system });
  }
  messages.push({ role: "user", content: request.prompt ?? "" });
  return messages;
}

/** Drops keys whose value is `undefined`, so a spread cannot erase what it lands on. */
function defined<T extends object>(settings: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(settings).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

/**
 * Maps the generation settings a text and a decision request share onto OpenAI
 * Chat Completions parameters, with unset keys omitted.
 *
 * Omitting matters: these are the top layer of a stack — the host's
 * {@link CreateOpenAiExecutorsOptions.settings}, then the request's — and an
 * `undefined` spread over the layer below would erase it.
 *
 * `max_tokens` is deprecated by OpenAI in favor of `max_completion_tokens`, so
 * that's what `maxOutputTokens` targets. Chat Completions has no `top_k`
 * parameter, so `topK` is dropped.
 */
export function toOpenAiCallSettings(
  request: Pick<
    AgentTextRequest,
    "temperature" | "maxOutputTokens" | "topP" | "seed" | "stopSequences"
  >,
) {
  return defined({
    temperature: request.temperature,
    max_completion_tokens: request.maxOutputTokens,
    top_p: request.topP,
    seed: request.seed,
    stop: request.stopSequences,
  });
}

/** A tool `description` may be a string or, for an AI SDK v7 tool, a function
 * of the call's context. A raw JSON payload can only carry the static form. */
function staticDescription(descriptor: AgentTool): string | undefined {
  if (typeof descriptor === "function") {
    return undefined;
  }
  return typeof descriptor.description === "string" ? descriptor.description : undefined;
}

/** One Responses API function tool per `AgentTools` entry. `strict` is sent as
 * `false` because the Responses API defaults it to `true`, and arbitrary JSON
 * Schema (e.g. from Zod) may fall outside OpenAI's strict-mode subset. */
export function toOpenAiTools(tools: AgentTools): FunctionTool[] {
  return Object.entries(tools).flatMap(([name, descriptor]) => {
    if (!descriptor) {
      return [];
    }
    const inputSchema = typeof descriptor === "function" ? undefined : descriptor.inputSchema;
    return [
      {
        type: "function" as const,
        name,
        description: staticDescription(descriptor),
        parameters:
          (isStandardSchema(inputSchema) ? getJsonSchemaSync(inputSchema) : undefined) ?? {},
        strict: false,
      },
    ];
  });
}

/**
 * Maps an {@link AgentToolChoice} onto the Responses API's `tool_choice` —
 * `{ type: 'tool', name }` becomes `{ type: 'function', name }`;
 * `'auto'`/`'none'`/`'required'` are OpenAI's own vocabulary and pass through.
 * `undefined` stays `undefined`, so the key is omitted.
 */
export function toOpenAiToolChoice(toolChoice: AgentToolChoice | undefined) {
  if (toolChoice === undefined) {
    return undefined;
  }
  return typeof toolChoice === "object"
    ? { type: "function" as const, name: toolChoice.name }
    : toolChoice;
}

/** One Responses API function tool per candidate decision event — the
 * "tool-per-event + tool_choice: 'required'" recipe, mirroring `toAiSdkEventTools`. */
export function toOpenAiEventTools(events: AgentEventDescriptor[]): FunctionTool[] {
  return events.map((event) => ({
    type: "function" as const,
    name: event.toolName,
    description: `Choose the '${event.type}' move.`,
    parameters: getJsonSchemaSync(event.inputSchema) ?? {},
    strict: false,
  }));
}

/** A Chat Completions content part as a Responses input part. `toOpenAiMessages`
 * only emits text and image parts. */
function toResponsesContentPart(part: ChatCompletionContentPart): ResponseInputContent {
  switch (part.type) {
    case "text":
      return { type: "input_text", text: part.text };
    case "image_url":
      return {
        type: "input_image",
        image_url: part.image_url.url,
        detail: part.image_url.detail ?? "auto",
      };
    default:
      return unsupportedPart("user", part.type);
  }
}

// The text of a Chat Completions message's content, string or text parts.
function contentText(content: string | Array<{ type: string; text?: string }> | null | undefined) {
  if (typeof content === "string" || content == null) {
    return content ?? "";
  }
  return content.map((part) => part.text ?? "").join("");
}

/**
 * Maps the Chat Completions messages {@link toOpenAiMessages} builds onto
 * Responses API input items: assistant `tool_calls` become `function_call`
 * items and tool messages become `function_call_output` items. Reusing the
 * Chat Completions mapping keeps one place that decides what a message part
 * means.
 */
export function toResponsesInput(messages: ChatCompletionMessageParam[]): ResponseInputItem[] {
  return messages.flatMap((message): ResponseInputItem[] => {
    switch (message.role) {
      case "system":
      case "developer":
        return [{ role: message.role, content: contentText(message.content) }];
      case "user":
        return [
          {
            role: "user",
            content:
              typeof message.content === "string"
                ? message.content
                : message.content.map(toResponsesContentPart),
          },
        ];
      case "assistant": {
        const text = contentText(message.content);
        return [
          ...(text ? [{ role: "assistant" as const, content: text }] : []),
          ...(message.tool_calls ?? []).flatMap((call) =>
            call.type === "function"
              ? [
                  {
                    type: "function_call" as const,
                    call_id: call.id,
                    name: call.function.name,
                    arguments: call.function.arguments,
                  },
                ]
              : [],
          ),
        ];
      }
      case "tool":
        return [
          {
            type: "function_call_output",
            call_id: message.tool_call_id,
            output: contentText(message.content),
          },
        ];
      default:
        return unsupportedPart(message.role, "message");
    }
  });
}

/**
 * Messages for a decision request, with prior failed `attempts` rendered as an
 * appended user message so retries converge. Mirrors the AI SDK adapter's
 * `toDecisionMessages`.
 */
export function toDecisionMessages(
  request: Pick<AgentDecisionRequest, "messages" | "prompt" | "events" | "attempts">,
): ChatCompletionMessageParam[] {
  const messages = toOpenAiMessages(request);
  for (const attempt of renderDecisionAttempts(request)) {
    messages.push({ role: "user", content: attempt.content as string });
  }
  return messages;
}

// ─── Result mapping ───

type OpenAiUsage = NonNullable<ChatCompletion["usage"]>;

/**
 * Folds OpenAI's usage payload onto the flat {@link AgentCallUsage} field names
 * core aggregates. OpenAI nests the reasoning count under
 * `completion_tokens_details` and the cache-read count under
 * `prompt_tokens_details`; a field the response omitted stays omitted, so it
 * never contributes a `0` to a run's partial sums.
 */
export function toAgentCallUsage(usage: OpenAiUsage | undefined): AgentCallUsage | undefined {
  if (!usage) {
    return undefined;
  }
  const reasoningTokens = usage.completion_tokens_details?.reasoning_tokens;
  const cachedInputTokens = usage.prompt_tokens_details?.cached_tokens;
  return {
    ...(usage.prompt_tokens !== undefined ? { inputTokens: usage.prompt_tokens } : {}),
    ...(usage.completion_tokens !== undefined ? { outputTokens: usage.completion_tokens } : {}),
    ...(usage.total_tokens !== undefined ? { totalTokens: usage.total_tokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
  };
}

/**
 * Maps an OpenAI `finish_reason` onto the portable {@link AgentFinishReason}.
 * `'function_call'` (the deprecated legacy path) joins `'tool_calls'` under
 * `'tool-calls'`; anything unrecognized, including a missing reason, lands on
 * `'other'`. OpenAI's own string stays on the result's `raw`.
 */
export function toAgentFinishReason(
  finishReason: ChatCompletion.Choice["finish_reason"] | null | undefined,
): AgentFinishReason {
  switch (finishReason) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "tool_calls":
    case "function_call":
      return "tool-calls";
    case "content_filter":
      return "content-filter";
    default:
      return "other";
  }
}

// The function calls a Responses API response asked for, in order.
function functionCalls(response: Pick<Response, "output">): ResponseFunctionToolCall[] {
  return (response.output ?? []).filter(
    (item): item is ResponseFunctionToolCall => item.type === "function_call",
  );
}

// The concatenated `output_text` of a Responses API response.
function outputText(response: Pick<Response, "output">): string {
  let text = "";
  for (const item of response.output ?? []) {
    if (item.type === "message") {
      for (const part of item.content) {
        if (part.type === "output_text") {
          text += part.text;
        }
      }
    }
  }
  return text;
}

/** {@link toAgentCallUsage} for a Responses API usage payload, which names its
 * fields `input_tokens`/`output_tokens`. */
export function toAgentResponseUsage(
  usage: ResponseUsage | null | undefined,
): AgentCallUsage | undefined {
  if (!usage) {
    return undefined;
  }
  const reasoningTokens = usage.output_tokens_details?.reasoning_tokens;
  const cachedInputTokens = usage.input_tokens_details?.cached_tokens;
  return {
    ...(usage.input_tokens !== undefined ? { inputTokens: usage.input_tokens } : {}),
    ...(usage.output_tokens !== undefined ? { outputTokens: usage.output_tokens } : {}),
    ...(usage.total_tokens !== undefined ? { totalTokens: usage.total_tokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
  };
}

/**
 * The portable {@link AgentFinishReason} of a Responses API response, which has
 * no `finish_reason`: an `incomplete` status carries the reason, and a
 * completed response that asked for function calls stopped for them.
 */
export function toAgentResponseFinishReason(
  response: Pick<Response, "status" | "incomplete_details" | "output">,
): AgentFinishReason {
  if (response.status === "incomplete") {
    switch (response.incomplete_details?.reason) {
      case "max_output_tokens":
        return "length";
      case "content_filter":
        return "content-filter";
      default:
        return "other";
    }
  }
  if (functionCalls(response).length > 0) {
    return "tool-calls";
  }
  return response.status === "completed" ? "stop" : "other";
}

/**
 * Throws for a `failed` Responses API response. The SDK returns one without
 * throwing, and passing it on would record an empty result as a success.
 */
function assertNotFailed(response: Response, executor: string): void {
  if (response.status === "failed") {
    throw new Error(
      `createOpenAiExecutors: ${executor} — the Responses API call failed` +
        (response.error ? ` (${response.error.code}: ${response.error.message})` : "") +
        ".",
    );
  }
}

// Sampling settings a model may reject (reasoning models reject `temperature`
// and `top_p`; older models reject `reasoning`). See `createResponse`.
const REJECTABLE_SETTINGS = ["temperature", "top_p", "top_logprobs", "reasoning"];

/** The top-level parameter an OpenAI `unsupported_parameter` 400 names, if any. */
function unsupportedParameter(error: unknown): string | undefined {
  const { status, param, message } = (error ?? {}) as {
    status?: unknown;
    param?: unknown;
    message?: unknown;
  };
  if (status !== 400) return undefined;
  const named =
    typeof param === "string"
      ? param
      : /Unsupported parameter: '([\w.]+)'/.exec(String(message))?.[1];
  return named?.split(".")[0];
}

// The Chat Completions settings the Responses API accepts under the same name.
const RESPONSES_SHARED_SETTINGS = [
  "metadata",
  "moderation",
  "parallel_tool_calls",
  "prompt_cache_key",
  "prompt_cache_options",
  "prompt_cache_retention",
  "safety_identifier",
  "service_tier",
  "store",
  "temperature",
  "top_logprobs",
  "top_p",
  "user",
];

/** Chat Completions settings `toResponsesSettings` renames onto the Responses API. */
const RESPONSES_TRANSLATED_SETTINGS = [
  "max_completion_tokens",
  "max_tokens",
  "reasoning_effort",
  "verbosity",
];

/**
 * Translates Chat Completions settings onto the Responses API: the settings it
 * shares by name pass through, `reasoning_effort` becomes `reasoning.effort`,
 * `max_completion_tokens` (or `max_tokens`) becomes `max_output_tokens`, and
 * `verbosity` becomes `text.verbosity`. Everything else is Chat-only (`seed`,
 * `stop`, `logprobs`, `prediction`, …) and is dropped with a warning, the way
 * the AI SDK's Responses provider drops what it cannot send, rather than
 * failing the call. `warned` holds the keys already warned about, so a tool
 * loop warns once per key, not once per step.
 */
function toResponsesSettings(settings: OpenAiCallSettings, warned: Set<string>) {
  const { reasoning_effort, max_completion_tokens, max_tokens, verbosity } = settings;
  const entries = Object.entries(settings).filter(([, value]) => value !== undefined);
  const shared = Object.fromEntries(
    entries.filter(([key]) => RESPONSES_SHARED_SETTINGS.includes(key)),
  );
  for (const [key] of entries) {
    if (RESPONSES_SHARED_SETTINGS.includes(key) || RESPONSES_TRANSLATED_SETTINGS.includes(key)) {
      continue;
    }
    if (warned.has(key)) continue;
    warned.add(key);
    console.warn(
      `@statelyai/agent/openai: the Responses API has no \`${key}\` parameter, so it was dropped ` +
        `from this call. A request's \`seed\` and \`stopSequences\` map to \`seed\` and \`stop\`.`,
    );
  }
  const maxOutputTokens = max_completion_tokens ?? max_tokens;
  return {
    ...shared,
    ...(reasoning_effort != null ? { reasoning: { effort: reasoning_effort } } : {}),
    ...(maxOutputTokens != null ? { max_output_tokens: maxOutputTokens } : {}),
    ...(verbosity != null ? { text: { verbosity } } : {}),
  };
}

// ─── createOpenAiExecutors ───

/**
 * Per-call OpenAI Chat Completions parameters a host can apply on top of what
 * the machine asked for — `reasoning_effort`, `service_tier`,
 * `max_completion_tokens`, and anything else the API accepts. Typed straight
 * off the installed `openai` package, so it tracks that version instead of
 * restating its vocabulary. Calls that go through the Responses API translate
 * `reasoning_effort`, `max_completion_tokens`, and `verbosity` onto its names
 * and drop, with a warning, the settings it has no equivalent for, such as `seed`, `stop`,
 * `logprobs`, and `prediction`.
 *
 * The request's own fields are excluded: `model`, `messages`, `tools`,
 * `tool_choice`, `response_format`, `n`, and the streaming switches belong to
 * the machine and the adapter, and a host override would silently contradict
 * them.
 */
export type OpenAiCallSettings = Omit<
  Partial<ChatCompletionCreateParamsNonStreaming>,
  "model" | "messages" | "tools" | "tool_choice" | "response_format" | "n" | "stream"
>;

/**
 * Options for {@link createOpenAiExecutors}.
 *
 * `client` is the injected `OpenAI` instance — this adapter never constructs
 * one, so the API key, base URL, and transport stay the host's business.
 *
 * `resolveModel` maps a machine's model *ref* (e.g. `'ticketTriage'`) to a real
 * OpenAI model id. A machine's requests carry refs, not ids, so a raw-SDK host
 * must resolve them (the AI SDK adapter does this via its `models` map).
 * Defaults to identity, for machines that already use real ids.
 *
 * `settings` carries provider knobs that are the HOST's business rather than
 * the machine's, such as reasoning effort. Pass a map keyed by model ref to
 * give a ref a persona — `deep` thinks harder than `quick` — without the
 * machine naming a provider knob, or a function to vary settings per request
 * (`request.name` is the request's registered key; return `undefined` for the
 * defaults). Settings are merged UNDER what the request declared, so a machine
 * that set `maxOutputTokens` still wins.
 */
export type CreateOpenAiExecutorsOptions = {
  client: OpenAI;
  resolveModel?: (modelRef: string) => string;
  settings?:
    | Record<string, OpenAiCallSettings>
    | ((request: AgentTextRequest | AgentDecisionRequest) => OpenAiCallSettings | undefined);
};

/** Resolves the host's `settings` option for one request. */
function callSettings(
  options: CreateOpenAiExecutorsOptions,
  request: AgentTextRequest | AgentDecisionRequest,
): OpenAiCallSettings {
  const settings = options.settings;
  if (typeof settings === "function") {
    return settings(request) ?? {};
  }
  const entry = settings?.[request.model];
  if (entry === undefined) {
    return {};
  }
  if (typeof entry !== "object" || entry === null) {
    throw new Error(
      `createOpenAiExecutors: \`settings\` is keyed by model ref, so every value must be an ` +
        `object of OpenAI parameters, but '${request.model}' is a ${typeof entry}. Pass a ` +
        "function if you want one set of settings for every call.",
    );
  }
  return entry;
}

/**
 * Raw result shape from {@link OpenAiExecutors.generateText} — `result` (the
 * validated structured object for structured-output requests, or the model's
 * text otherwise) plus the call metadata. Core reads `result` and `usage`;
 * everything else flows verbatim to `createAgentRuntime`'s `onResult(request, { raw })`.
 */
export type OpenAiGenerateResult = {
  result: unknown;
  /** The model's reasoning, present only when the request opted in via
   * `includeReasoning` and the model produced it. Never enters machine
   * context/output. */
  reasoning?: string;
  /** The call's token usage, on the flat field names the runtime folds into the
   * run result's aggregated `AgentUsage`. Absent when OpenAI reported none. */
  usage?: AgentCallUsage;
  /** Why the call stopped, normalized to the portable {@link AgentFinishReason}. OpenAI's own value stays on `raw`. */
  finishReason: AgentFinishReason;
  /** OpenAI calls the tool loop made. */
  modelCalls: number;
  /** The untouched OpenAI response. */
  raw: unknown;
};

/** Raw result shape from {@link OpenAiExecutors.streamText} — the accumulated text once the stream finishes (chunks are delivered separately via `onChunk`), plus the stream's final usage/finish metadata. */
export type OpenAiStreamResult = {
  result: string;
  /** Present when the stream carried a usage chunk (the adapter asks for one via `stream_options`). */
  usage?: AgentCallUsage;
  finishReason: AgentFinishReason;
  /** The last chunk seen, which carries the stream's finish metadata. */
  raw: unknown;
};

/** Raw result shape from {@link OpenAiExecutors.decide} — the chosen event (or the answer's rejection) plus the call metadata, delivered per decision attempt to `onResult`. */
export type OpenAiDecideResult = (
  | { event: ChosenEvent; rejected?: undefined }
  | { event?: undefined; rejected: AgentDecisionRejection }
) & {
  usage?: AgentCallUsage;
  finishReason: AgentFinishReason;
  raw: unknown;
};

/** `createOpenAiExecutors` always populates all three slots (unlike the general
 * `AgentRequestExecutors`, where `streamText`/`decide` are optional), and its
 * results are concretely typed. */
export interface OpenAiExecutors {
  generateText: (
    request: AgentTextRequest & { tools: AgentTools },
    info?: AgentRequestExecutorInfo,
  ) => Promise<OpenAiGenerateResult>;
  streamText: (
    request: AgentTextRequest & { tools: AgentTools },
    info?: AgentRequestExecutorInfo,
  ) => Promise<OpenAiStreamResult>;
  decide: (
    request: AgentDecisionRequest,
    info?: AgentRequestExecutorInfo,
  ) => Promise<OpenAiDecideResult>;
}

// Builds the AgentTruncatedError the adapter throws when a `'length'` finish
// reason left nothing usable. `what` names the part that was cut off.
function truncated(
  request: AgentTextRequest,
  info: AgentRequestExecutorInfo | undefined,
  partialOutput?: unknown,
  cause?: unknown,
): AgentTruncatedError {
  return new AgentTruncatedError(
    `createOpenAiExecutors: request '${request.name ?? "(unnamed)"}' hit the output token ` +
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

// The `usage` key, present only when OpenAI reported one.
function usageField(usage: AgentCallUsage | undefined): { usage?: AgentCallUsage } {
  return usage ? { usage } : {};
}

/**
 * Adds two calls' usage together, field by field. A tool loop makes several
 * OpenAI calls per request, and core folds ONE `usage` per executor result into
 * the run's totals, so the steps' usages have to be summed here or the run
 * undercounts. A field neither call reported stays absent.
 */
export function addAgentCallUsage(
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
 * The function that runs one of the request's tools host-side, or `undefined`
 * when the tool has no `execute` (a client-side tool: the model's call is
 * handed back to the caller instead of being answered here).
 */
function toolExecutor(tools: AgentTools, name: string): ((input: unknown) => unknown) | undefined {
  const descriptor = tools[name];
  if (!descriptor) {
    return undefined;
  }
  if (typeof descriptor === "function") {
    return (input) => descriptor(input);
  }
  const execute = descriptor.execute;
  return typeof execute === "function" ? (input) => execute(input) : undefined;
}

// A tool's return value as the string an OpenAI tool message carries.
function toToolContent(output: unknown): string {
  return typeof output === "string" ? output : JSON.stringify(output ?? null);
}

/**
 * Builds the `{ generateText, streamText, decide }` executor set for the raw
 * `openai` package. Compare `createAiSdkExecutors` — same shape, different SDK
 * underneath.
 *
 * Calls with function tools use the Responses API, which reasoning models
 * require for tools: decisions force a call with `tool_choice: 'required'`, one
 * function tool per candidate event, and `generateText` runs its tool loop
 * there. Tool-free calls use Chat Completions. Structured output wraps the
 * `{ result, reasoning? }` provider output schema in a `json_schema` format on
 * either API.
 *
 * @example
 * ```ts
 * const executors = createOpenAiExecutors({
 *   client: new OpenAI(),
 *   resolveModel: () => 'gpt-6-luna',
 * });
 * const result = await runToQuiescence(createAgentRuntime(machine, { executors }), { input });
 * ```
 */
export function createOpenAiExecutors(options: CreateOpenAiExecutorsOptions): OpenAiExecutors {
  const { client, resolveModel = (modelRef: string) => modelRef } = options;
  const warnedSettings = new Set<string>();
  // Resolved model id → the settings it rejected. A model learns each rejected
  // setting once; later calls to it leave the setting out.
  const rejectedSettings = new Map<string, Set<string>>();

  // `client.responses.create`, minus the sampling settings the model rejects.
  // OpenAI answers a setting a model does not support (`temperature` on a
  // reasoning model) with a 400 rather than ignoring it, so the first such 400
  // drops that setting for the model, warns once, and retries without it.
  const createResponse = async (
    params: ResponseCreateParamsNonStreaming,
    signal: AbortSignal | undefined,
  ): Promise<Response> => {
    const rejected = rejectedSettings.get(params.model as string) ?? new Set<string>();
    const sent = Object.fromEntries(
      Object.entries(params).filter(([key]) => !rejected.has(key)),
    ) as ResponseCreateParamsNonStreaming;
    try {
      return (await client.responses.create(sent, { signal })) as Response;
    } catch (error) {
      const param = unsupportedParameter(error);
      if (param === undefined || !REJECTABLE_SETTINGS.includes(param) || !(param in sent)) {
        throw error;
      }
      rejectedSettings.set(params.model as string, rejected.add(param));
      console.warn(
        `@statelyai/agent/openai: \`${params.model}\` does not support \`${param}\`, so it is ` +
          `dropped from this executor's calls to that model.`,
      );
      return createResponse(params, signal);
    }
  };

  // Params every Responses API call shares. Host `settings` sit UNDER the
  // request's own settings, which are `defined()`-filtered so an unset request
  // field can never erase a host one. `store: false` matches Chat Completions,
  // which keeps nothing unless asked; a host can still set `store: true`.
  // `model`/`input` are written first and are not settable, so the cast only
  // re-asserts what the spreads preserve.
  const responsesParams = (
    request: AgentTextRequest | AgentDecisionRequest,
    input: ResponseInputItem[],
    extra: Partial<ResponseCreateParamsNonStreaming>,
  ): ResponseCreateParamsNonStreaming => {
    const settings = toResponsesSettings(
      {
        ...callSettings(options, request),
        ...toOpenAiCallSettings(request),
      },
      warnedSettings,
    );
    return {
      model: resolveModel(request.model),
      input,
      store: false,
      ...settings,
      ...extra,
      ...(settings.text || extra.text ? { text: { ...settings.text, ...extra.text } } : {}),
    } as ResponseCreateParamsNonStreaming;
  };

  // The JSON Schema for the `{ result, reasoning? }` provider output, or `undefined`
  // when the request's schema doesn't expose the `~standard.jsonSchema`
  // extension — in which case the call falls back to plain text.
  const structuredSchema = async (request: AgentTextRequest) => {
    if (getAgentOutputMode(request.outputSchema) !== "structured") {
      return undefined;
    }
    // The structured-output contract (see docs/hosts.md): send the declared
    // schema wrapped as `{ result, reasoning? }` — a root object is universally
    // accepted — and return the parsed `result`, which the machine validates
    // against the bare schema it declared.
    return getJsonSchema(
      providerOutputSchema(request.outputSchema!, { reasoning: request.includeReasoning }),
    );
  };

  type TextCallOutcome = {
    content: string | null | undefined;
    finishReason: AgentFinishReason;
    usage: AgentCallUsage | undefined;
    modelCalls: number;
    raw: unknown;
  };

  // A tool-free text call: one Chat Completions request.
  const chatCompletion = async (
    request: AgentTextRequest,
    jsonSchema: Record<string, unknown> | undefined,
    info?: AgentRequestExecutorInfo,
  ): Promise<TextCallOutcome> => {
    const response = (await client.chat.completions.create(
      {
        model: resolveModel(request.model),
        messages: toOpenAiMessages(request),
        ...callSettings(options, request),
        ...toOpenAiCallSettings(request),
        ...(jsonSchema
          ? {
              response_format: {
                type: "json_schema",
                json_schema: {
                  name: "output",
                  schema: jsonSchema,
                  // Arbitrary JSON Schema (e.g. from Zod) may use features
                  // outside OpenAI's strict-mode subset (defaults, unions, …) —
                  // leaving strict mode off keeps this general rather than
                  // requiring schema authors to hand-tune for OpenAI.
                  strict: false,
                },
              },
            }
          : {}),
      } as ChatCompletionCreateParamsNonStreaming,
      { signal: info?.signal },
    )) as ChatCompletion;
    const choice = response.choices[0];
    return {
      content: choice?.message.content,
      finishReason: toAgentFinishReason(choice?.finish_reason),
      usage: toAgentCallUsage(response.usage),
      modelCalls: 1,
      raw: response,
    };
  };

  // The host-side tool loop, over the Responses API. `maxSteps` bounds the
  // number of OpenAI calls (default 1, single-step, like the AI SDK adapter):
  // each step that comes back with function calls runs them, appends the calls
  // and one `function_call_output` per result, and asks again. The loop ends on
  // a step with no function calls, on the step budget, or on a tool with no
  // `execute` — a client-side tool, whose call belongs to the caller, so the
  // result comes back with `finishReason: 'tool-calls'` and the raw response.
  // A non-finite `maxSteps` (NaN, Infinity) would never satisfy the bound
  // check below and let a model that keeps calling tools run unbounded, so
  // it falls back to the single-call default like an absent value.
  const responsesToolLoop = async (
    request: AgentTextRequest & { tools: AgentTools },
    tools: FunctionTool[],
    jsonSchema: Record<string, unknown> | undefined,
    info?: AgentRequestExecutorInfo,
  ): Promise<TextCallOutcome> => {
    const maxSteps =
      typeof request.maxSteps === "number" && Number.isFinite(request.maxSteps)
        ? Math.max(1, Math.floor(request.maxSteps))
        : 1;
    const input = toResponsesInput(toOpenAiMessages(request));
    const toolChoice = toOpenAiToolChoice(request.toolChoice);
    let response: Response;
    let usage: AgentCallUsage | undefined;
    let step = 0;

    try {
      for (;;) {
        step++;
        response = await createResponse(
          responsesParams(request, [...input], {
            tools,
            ...(jsonSchema
              ? {
                  // `strict: false` for the same reason as the tools above.
                  text: {
                    format: {
                      type: "json_schema",
                      name: "output",
                      schema: jsonSchema,
                      strict: false,
                    },
                  },
                }
              : {}),
            // A forced choice applies to the FIRST step only: re-sending
            // `'required'` after a tool ran would force another call every step
            // and burn the budget without ever producing an answer.
            ...(step === 1 && toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
          }),
          info?.signal,
        );
        assertNotFailed(response, "generateText");
        usage = addAgentCallUsage(usage, toAgentResponseUsage(response.usage));

        const calls = functionCalls(response);
        // An incomplete turn (e.g. cut off at `max_output_tokens`) never runs its
        // calls: the model did not finish deciding them. It ends the loop with
        // its finish reason, so a structured request still reports truncation.
        if (calls.length === 0 || step >= maxSteps || response.status === "incomplete") {
          break;
        }
        // An offered tool with no `execute` hands the call back: the loop ends.
        // A tool that was not offered is answered with an error result below.
        const offered = (name: string) =>
          Object.hasOwn(request.tools, name) && request.tools[name] !== undefined;
        if (calls.some((call) => offered(call.name) && !toolExecutor(request.tools, call.name))) {
          break;
        }

        // Replay the step statelessly: the model's text and calls go back without
        // their item ids, and reasoning items are left out, since with
        // `store: false` there is no stored item for an id to point at.
        const text = outputText(response);
        if (text) {
          input.push({ role: "assistant", content: text });
        }
        for (const { call_id, name, arguments: args } of calls) {
          // A zero-argument call may come back with `""`; replay it as the JSON object it means.
          input.push({ type: "function_call", call_id, name, arguments: args || "{}" });
          let output: string;
          try {
            if (!offered(name)) {
              throw new Error(
                `tool '${name}' was not offered; valid tools: ${Object.keys(request.tools)
                  .filter(offered)
                  .join(", ")}`,
              );
            }
            let toolInput: unknown = {};
            if (args) {
              try {
                toolInput = JSON.parse(args);
              } catch {
                throw new Error(`the arguments for tool '${name}' were not valid JSON`);
              }
            }
            output = toToolContent(await toolExecutor(request.tools, name)!(toolInput));
          } catch (error) {
            // A thrown tool, a tool that was not offered, or arguments that are
            // not JSON go back to the model as an error result, the way the AI
            // SDK's loop reports them, rather than failing the request.
            output = `Error: ${error instanceof Error ? error.message : String(error)}`;
          }
          input.push({ type: "function_call_output", call_id, output });
        }
      }
    } catch (error) {
      throw withModelCalls(error, step);
    }

    return {
      content: outputText(response),
      finishReason: toAgentResponseFinishReason(response),
      usage,
      modelCalls: step,
      raw: response,
    };
  };

  const generateText = async (
    request: AgentTextRequest & { tools: AgentTools },
    info?: AgentRequestExecutorInfo,
  ): Promise<OpenAiGenerateResult> => {
    const jsonSchema = await structuredSchema(request);
    const tools = toOpenAiTools(request.tools);
    const { content, finishReason, usage, modelCalls, raw } =
      tools.length > 0
        ? await responsesToolLoop(request, tools, jsonSchema, info)
        : await chatCompletion(request, jsonSchema, info);

    try {
      if (jsonSchema) {
        // A structured request that ran out of tokens has no usable output: the
        // JSON object never closed, and even a closed one only closed because the
        // model stopped mid-thought. Either way, not a final answer for a
        // machine — `partialOutput` carries whatever text did arrive.
        if (finishReason === "length") {
          throw truncated(request, info, content || undefined);
        }
        // Validated parse of the `{ result, reasoning? }` provider output — no cast.
        const parsed = parseProviderOutput(request, content ? JSON.parse(content) : undefined);
        return {
          result: parsed.result,
          ...(typeof parsed.reasoning === "string" ? { reasoning: parsed.reasoning } : {}),
          ...usageField(usage),
          finishReason,
          modelCalls,
          raw,
        };
      }
    } catch (error) {
      throw withModelCalls(error, modelCalls);
    }

    // A text request that ran out of tokens still has its text. It comes back
    // with `finishReason: 'length'` — the machine decides what that is worth.
    return {
      result: content ?? "",
      ...usageField(usage),
      finishReason,
      modelCalls,
      raw,
    };
  };

  const streamText = async (
    request: AgentTextRequest & { tools: AgentTools },
    info?: AgentRequestExecutorInfo,
  ): Promise<OpenAiStreamResult> => {
    // Text-only by design: no tools, no `response_format`. A chunk-by-chunk
    // structured object has nothing useful to hand `onChunk` mid-stream, so
    // a request that needs either is refused rather than silently downgraded
    // to unstructured text.
    if (getAgentOutputMode(request.outputSchema) === "structured") {
      throw new Error(
        "createOpenAiExecutors: streamText is text-only \u2014 a request declaring a structured " +
          "output schema must be routed to generateText.",
      );
    }
    if (Object.keys(request.tools ?? {}).length > 0) {
      throw new Error(
        "createOpenAiExecutors: streamText is text-only \u2014 a request declaring tools must be " +
          "routed to generateText.",
      );
    }

    const stream = (await client.chat.completions.create(
      {
        model: resolveModel(request.model),
        messages: toOpenAiMessages(request),
        ...callSettings(options, request),
        ...toOpenAiCallSettings(request),
        stream: true,
        // Chat Completions omits usage from a stream unless asked, so ask —
        // it arrives on a final chunk with no choices.
        stream_options: { include_usage: true },
      } as ChatCompletionCreateParamsStreaming,
      { signal: info?.signal },
    )) as AsyncIterable<ChatCompletionChunk>;

    let text = "";
    let finishReason: AgentFinishReason = "other";
    let usage: OpenAiUsage | undefined;
    let last: ChatCompletionChunk | undefined;
    for await (const chunk of stream) {
      last = chunk;
      const choice = chunk.choices[0];
      const delta = choice?.delta.content;
      if (delta) {
        text += delta;
        info?.onChunk?.(delta);
      }
      if (choice?.finish_reason) {
        finishReason = toAgentFinishReason(choice.finish_reason);
      }
      if (chunk.usage) {
        usage = chunk.usage;
      }
    }

    return { result: text, ...usageField(toAgentCallUsage(usage)), finishReason, raw: last };
  };

  const decide = async (
    request: AgentDecisionRequest,
    info?: AgentRequestExecutorInfo,
  ): Promise<OpenAiDecideResult> => {
    const response = await createResponse(
      responsesParams(request, toResponsesInput(toDecisionMessages(request)), {
        tools: toOpenAiEventTools(request.events),
        tool_choice: "required",
      }),
      info?.signal,
    );
    assertNotFailed(response, "decide");

    // An incomplete turn did not finish choosing, so its call is not a choice.
    if (response.status === "incomplete") {
      throw new Error(
        "createOpenAiExecutors: decide — the response was incomplete " +
          `(${response.incomplete_details?.reason ?? "unknown reason"}), so no event was chosen.`,
      );
    }
    const toolCall = functionCalls(response)[0];
    // An answer that names no candidate is retried, not thrown.
    const unnamed = (call?: { toolName: string; invalidJson?: boolean }): OpenAiDecideResult => ({
      rejected: rejectedAnswer(
        call,
        request.events.map((event) => event.toolName),
      ),
      ...usageField(toAgentResponseUsage(response.usage)),
      finishReason: toAgentResponseFinishReason(response),
      raw: response,
    });
    if (!toolCall) return unnamed();
    const toolName = toolCall.name;
    const chosenEvent = request.events.find((event) => event.toolName === toolName);
    if (!chosenEvent) return unnamed({ toolName });

    let args: unknown = {};
    try {
      if (toolCall.arguments) args = JSON.parse(toolCall.arguments);
    } catch {
      return unnamed({ toolName, invalidJson: true });
    }

    return {
      // The event's own `type` is spread LAST so it always wins: a stray
      // `type` key in the model's tool input can never override the machine
      // event type.
      event: {
        ...(args && typeof args === "object" ? args : {}),
        type: chosenEvent.type,
      } as ChosenEvent,
      ...usageField(toAgentResponseUsage(response.usage)),
      finishReason: toAgentResponseFinishReason(response),
      raw: response,
    };
  };

  return { generateText, streamText, decide };
}
