/**
 * Pure mappings from the agent's request shapes onto TanStack AI's `chat()`
 * options. Internal to the `/tanstack-ai` adapter.
 */
import type { AnyTextAdapter, ContentPart, ModelMessage, Tool } from "@tanstack/ai";
import type { AgentTextRequest } from "../text-logic.js";
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
export type GenerationSettings = Pick<
  AgentTextRequest,
  "temperature" | "maxOutputTokens" | "topP" | "topK" | "seed" | "stopSequences"
>;

/** Drops keys whose value is `undefined`, so a spread cannot erase what it lands on. */
export function defined<T extends object>(settings: T): Partial<T> {
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
 *   `stop_sequences`, `tool_choice`. `seed` is dropped.
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
              : toolChoice === undefined
                ? undefined
                : { type: toolChoice },
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
