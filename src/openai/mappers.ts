/**
 * Pure mappings between the agent's request and result shapes and the `openai`
 * package's Chat Completions and Responses API params. Internal to the
 * `/openai` adapter.
 */
import type {
  ChatCompletion,
  ChatCompletionAssistantMessageParam,
  ChatCompletionContentPart,
  ChatCompletionMessageParam,
  // `ChatCompletionTool` spans the whole supported `openai` peer range; the
  // narrower `ChatCompletionFunctionTool` name only exists in later releases.
  ChatCompletionTool,
} from "openai/resources/chat/completions/completions.js";
import type {
  FunctionTool,
  ResponseInputContent,
  ResponseInputItem,
} from "openai/resources/responses/responses.js";
import type { AgentFinishReason, AgentTextRequest } from "../text-logic.js";
import type { AgentEventDescriptor } from "../events.js";
import type {
  AgentMessage,
  AgentTool,
  AgentToolChoice,
  AgentTools,
  DataContent,
  ToolResultPart,
} from "../types.js";
import { getJsonSchemaSync, isStandardSchema } from "../utils.js";

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
export function defined<T extends object>(settings: T): Partial<T> {
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

/** Responses API function tools as Chat Completions tools, for `api: 'chat'`. */
export function toChatTools(tools: FunctionTool[]): ChatCompletionTool[] {
  return tools.map(({ name, description, parameters, strict }) => ({
    type: "function" as const,
    function: {
      name,
      ...(description != null ? { description } : {}),
      parameters: parameters ?? {},
      ...(strict != null ? { strict } : {}),
    },
  }));
}

/** {@link toOpenAiToolChoice} in Chat Completions' shape, for `api: 'chat'`. */
export function toChatToolChoice(toolChoice: AgentToolChoice | undefined) {
  if (toolChoice === undefined) {
    return undefined;
  }
  return typeof toolChoice === "object"
    ? { type: "function" as const, function: { name: toolChoice.name } }
    : toolChoice;
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

// ─── Result mapping ───

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
