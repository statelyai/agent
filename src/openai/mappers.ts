// Adapter-internal request/result mappers for the raw `openai` adapter. NOT
// part of the public `@statelyai/agent/openai` entry point —
// `createOpenAiExecutors` (in ./index.ts) is the supported surface; these are
// imported by it and by the adapter's unit tests only.
import type {
  ChatCompletion,
  ChatCompletionAssistantMessageParam,
  ChatCompletionContentPart,
  ChatCompletionMessageParam,
  // `ChatCompletionTool` spans the whole supported `openai` peer range; the
  // narrower `ChatCompletionFunctionTool` name only exists in later releases.
  ChatCompletionTool,
} from "openai/resources/chat/completions/completions.js";
import type { AgentCallUsage, AgentTextRequest } from "../text-logic.js";
import type { AgentDecisionRequest } from "../decision.js";
import type { AgentEventDescriptor } from "../events.js";
import type {
  AgentMessage,
  AgentToolChoice,
  AgentTools,
  DataContent,
  ToolResultPart,
} from "../types.js";
import { getJsonSchemaSync, isStandardSchema } from "../utils.js";
import {
  decisionAttemptMessages,
  defined,
  eventToolDescription,
  staticDescription,
  toBase64,
  toolResultContent,
  unsupportedPart,
} from "../internal/adapter-kit.js";

const ADAPTER = "createOpenAiExecutors";

// ─── Request → OpenAI param mapping ───

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
  return `data:${type};base64,${toBase64(ADAPTER, image)}`;
}

/** One OpenAI tool message per `ToolResultPart` — the tool role is one message per result. */
function toToolMessage(part: ToolResultPart): ChatCompletionMessageParam {
  return { role: "tool", content: toolResultContent(part), tool_call_id: part.toolCallId };
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
                return unsupportedPart(ADAPTER, "Chat Completions", "user", part.type);
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
                unsupportedPart(ADAPTER, "Chat Completions", "assistant", part.type);
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

/**
 * Maps the generation settings a text and a decision request share onto OpenAI
 * Chat Completions parameters, with unset keys omitted.
 *
 * Omitting matters: these are the top layer of a stack — the host's
 * `createOpenAiExecutors({ settings })`, then the request's — and an
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

/** One OpenAI function tool per `AgentTools` entry. */
export function toOpenAiTools(tools: AgentTools): ChatCompletionTool[] {
  return Object.entries(tools).flatMap(([name, descriptor]) => {
    if (!descriptor) {
      return [];
    }
    const inputSchema = typeof descriptor === "function" ? undefined : descriptor.inputSchema;
    return [
      {
        type: "function" as const,
        function: {
          name,
          description: staticDescription(descriptor),
          parameters:
            (isStandardSchema(inputSchema) ? getJsonSchemaSync(inputSchema) : undefined) ?? {},
        },
      },
    ];
  });
}

/**
 * Maps an {@link AgentToolChoice} onto OpenAI's `tool_choice` —
 * `{ type: 'tool', name }` becomes `{ type: 'function', function: { name } }`;
 * `'auto'`/`'none'`/`'required'` are OpenAI's own vocabulary and pass through.
 * `undefined` stays `undefined`, so the key is omitted.
 */
export function toOpenAiToolChoice(toolChoice: AgentToolChoice | undefined) {
  if (toolChoice === undefined) {
    return undefined;
  }
  return typeof toolChoice === "object"
    ? { type: "function" as const, function: { name: toolChoice.name } }
    : toolChoice;
}

/** One OpenAI function tool per candidate decision event — the "tool-per-event
 * + tool_choice: 'required'" recipe, mirroring `toAiSdkEventTools`. */
export function toOpenAiEventTools(events: AgentEventDescriptor[]): ChatCompletionTool[] {
  return events.map((event) => ({
    type: "function" as const,
    function: {
      name: event.toolName,
      description: eventToolDescription(event),
      parameters: getJsonSchemaSync(event.inputSchema) ?? {},
    },
  }));
}

/**
 * Messages for a decision request, with prior failed `attempts` rendered as an
 * appended user message so retries converge. Mirrors the AI SDK adapter's
 * `toDecisionMessages`.
 */
export function toDecisionMessages(
  request: Pick<AgentDecisionRequest, "messages" | "prompt" | "events" | "attempts">,
): ChatCompletionMessageParam[] {
  return [...toOpenAiMessages(request), ...decisionAttemptMessages(request)];
}

// ─── Result mapping ───

export type OpenAiUsage = NonNullable<ChatCompletion["usage"]>;

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
