import type { EventObject } from "xstate";
import type { AgentMessage, StandardSchemaV1 } from "./types.js";

// ─── Message helpers ───
//
// Messages are plain context state: declare a `messages` field in the
// context schema and update it with `appendMessages(...)`:
//
//   actions: appendMessages(({ event }) => userMessage(event.prompt))

// Resolves `resolve` and returns the full new `messages` array (existing + appended).
function addMessages<TContext extends { messages: AgentMessage[] }, TEvent extends EventObject>(
  resolve:
    | AgentMessage
    | AgentMessage[]
    | ((args: { context: TContext; event: TEvent }) => AgentMessage | AgentMessage[]),
): (args: { context: TContext; event: TEvent }) => AgentMessage[] {
  return (args) => {
    const resolved = typeof resolve === "function" ? resolve(args) : resolve;
    return [...args.context.messages, ...(Array.isArray(resolved) ? resolved : [resolved])];
  };
}

/**
 * Builds a transition-function result that appends one or more
 * {@link AgentMessage}s to a context's `messages` array. `resolve` is either
 * a message (or array of messages) or a function of `{ context, event }`
 * returning them; the returned function is meant to be used directly as (or
 * composed into) a transition's result, e.g. `on: { USER_REPLIED:
 * agent.appendMessages(({ event }) => userMessage(event.text)) }`. Requires
 * `messages: AgentMessage[]` on context — see {@link messagesSchema} for a
 * ready-made schema for that field.
 *
 * @example
 * ```ts
 * on: {
 *   USER_REPLIED: appendMessages(({ event }) => userMessage(event.text)),
 * }
 * ```
 */
export function appendMessages<
  TContext extends { messages: AgentMessage[] },
  TEvent extends EventObject,
>(
  resolve:
    | AgentMessage
    | AgentMessage[]
    | ((args: { context: TContext; event: TEvent }) => AgentMessage | AgentMessage[]),
): (args: { context: TContext; event: TEvent }) => {
  context: { messages: AgentMessage[] };
} {
  return (args: { context: TContext; event: TEvent }) => ({
    context: {
      messages: addMessages(resolve)(args),
    },
  });
}

type MessagePartType = "text" | "image" | "file" | "tool-call" | "tool-result";

// Recognized `AgentMessage` content part type tags, narrowed per role below.
const KNOWN_PART_TYPES = new Set<MessagePartType>([
  "text",
  "image",
  "file",
  "tool-call",
  "tool-result",
]);
const USER_PART_TYPES = new Set<MessagePartType>(["text", "image", "file"]);
const ASSISTANT_PART_TYPES = new Set<MessagePartType>(["text", "file", "tool-call", "tool-result"]);
const TOOL_PART_TYPES = new Set<MessagePartType>(["tool-result"]);
const TOOL_RESULT_CONTENT_PART_TYPES = new Set<MessagePartType>(["text", "image"]);

// True if `part` is an object with a recognized part `type`.
function isKnownPart(part: unknown): part is { type: MessagePartType } {
  const type = part && typeof part === "object" ? (part as { type?: unknown }).type : undefined;
  return typeof type === "string" && KNOWN_PART_TYPES.has(type as MessagePartType);
}

// Requires `field` on `part` to be a string; returns an error message, or undefined.
function requireString(
  part: Record<string, unknown>,
  type: string,
  field: string,
): string | undefined {
  return typeof part[field] === "string" ? undefined : `${type} part requires a string "${field}"`;
}

function isMediaData(value: unknown): boolean {
  return (
    typeof value === "string" ||
    value instanceof Uint8Array ||
    value instanceof ArrayBuffer ||
    value instanceof URL
  );
}

function requireMediaData(
  part: Record<string, unknown>,
  type: "image" | "file",
  field: "image" | "data",
): string | undefined {
  return isMediaData(part[field])
    ? undefined
    : `${type} part requires "${field}" to be a string, Uint8Array, ArrayBuffer, or URL`;
}

const TOOL_RESULT_OUTPUT_TYPES = new Set(["text", "json", "error-text", "error-json", "content"]);

// Validates a `tool-result` part's `output`; returns an error message, or undefined.
function validateToolResultOutput(output: unknown): string | undefined {
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    return 'tool-result part requires an "output" object';
  }
  const record = output as Record<string, unknown>;
  const outputType = record.type;
  if (typeof outputType !== "string" || !TOOL_RESULT_OUTPUT_TYPES.has(outputType)) {
    return `Unknown tool-result output type: ${JSON.stringify(outputType)}`;
  }
  if (outputType === "text" || outputType === "error-text") {
    if (typeof record.value !== "string") {
      return `tool-result output of type "${outputType}" requires a string "value"`;
    }
    return undefined;
  }
  if (outputType === "content") {
    if (!Array.isArray(record.value)) {
      return 'tool-result output of type "content" requires an array "value"';
    }
    for (const contentPart of record.value) {
      const error = validatePart(
        contentPart,
        TOOL_RESULT_CONTENT_PART_TYPES,
        "tool-result output content",
      );
      if (error) {
        return error;
      }
    }
    return undefined;
  }
  // "json" | "error-json": any defined value, including null.
  return record.value !== undefined
    ? undefined
    : `tool-result output of type "${outputType}" requires a "value"`;
}

// Validates a single content part's required fields; returns an error message, or undefined.
function validatePart(
  part: unknown,
  allowedTypes: ReadonlySet<MessagePartType>,
  location: string,
): string | undefined {
  if (!isKnownPart(part)) {
    const type = part && typeof part === "object" ? (part as { type?: unknown }).type : undefined;
    return `Unknown message part type: ${JSON.stringify(type)}`;
  }
  if (!allowedTypes.has(part.type)) {
    return `${location} does not allow "${part.type}" parts`;
  }
  const record = part as unknown as Record<string, unknown>;
  switch (record.type) {
    case "text":
      return requireString(record, "text", "text");
    case "image":
      return requireMediaData(record, "image", "image");
    case "file":
      return requireMediaData(record, "file", "data") ?? requireString(record, "file", "mediaType");
    case "tool-call":
      return (
        requireString(record, "tool-call", "toolCallId") ??
        requireString(record, "tool-call", "toolName") ??
        ("input" in record ? undefined : 'tool-call part requires an "input" value')
      );
    case "tool-result":
      return (
        requireString(record, "tool-result", "toolCallId") ??
        requireString(record, "tool-result", "toolName") ??
        validateToolResultOutput(record.output)
      );
    default:
      return undefined;
  }
}

// Validates a message `content` array of parts; returns an error message, or undefined if valid.
function validatePartsArray(
  content: unknown,
  allowedTypes: ReadonlySet<MessagePartType>,
  location: string,
): string | undefined {
  if (!Array.isArray(content)) {
    return "Expected content to be a string or an array of parts";
  }
  for (const part of content) {
    const error = validatePart(part, allowedTypes, location);
    if (error) {
      return error;
    }
  }
  return undefined;
}

/**
 * A {@link StandardSchemaV1} validating an `AgentMessage[]` context field —
 * checks that every message has a known `role` (`system`/`user`/`assistant`/
 * `tool`) and that `content` is either a string (where the role allows it) or
 * an array of role-appropriate parts whose required fields and media payloads
 * have the right runtime types (extra fields are allowed). Use it directly as
 * a context schema's `messages` field when authoring with `createAgentSchemas`.
 */
export const messagesSchema: StandardSchemaV1<AgentMessage[]> = {
  "~standard": {
    version: 1,
    vendor: "statelyai-agent",
    validate(value: unknown) {
      if (!Array.isArray(value)) {
        return { issues: [{ message: "Expected an array of agent messages" }] };
      }

      for (const message of value) {
        if (!message || typeof message !== "object") {
          return { issues: [{ message: "Expected an array of agent messages" }] };
        }

        const role = (message as { role?: unknown }).role;
        const content = (message as { content?: unknown }).content;

        if (role !== "system" && role !== "user" && role !== "assistant" && role !== "tool") {
          return {
            issues: [{ message: `Unknown message role: ${JSON.stringify(role)}` }],
          };
        }

        if (role === "system") {
          if (typeof content !== "string") {
            return {
              issues: [{ message: "system message content must be a string" }],
            };
          }
          continue;
        }

        if (role === "tool") {
          const error = validatePartsArray(content, TOOL_PART_TYPES, "tool message content");
          if (error) {
            return { issues: [{ message: error }] };
          }
          continue;
        }

        // user | assistant: string or a role-appropriate parts array
        if (typeof content === "string") {
          continue;
        }
        const error = validatePartsArray(
          content,
          role === "user" ? USER_PART_TYPES : ASSISTANT_PART_TYPES,
          `${role} message content`,
        );
        if (error) {
          return { issues: [{ message: error }] };
        }
      }

      return { value: value as AgentMessage[] };
    },
  },
};
