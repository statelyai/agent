import type { EventObject } from 'xstate';
import type { AgentMessage, StandardSchemaV1 } from './types.js';

// ─── Message helpers ───
//
// Messages are plain context state: declare a `messages` field in the
// context schema and update it with `appendMessages(...)`:
//
//   actions: appendMessages(({ event }) => userMessage(event.prompt))

export {
  assistantMessage,
  systemMessage,
  toolMessage,
  userMessage,
  validateSchemaSync,
} from './utils.js';

// Resolves `resolve` and returns the full new `messages` array (existing + appended).
function addMessages<
  TContext extends { messages: AgentMessage[] },
  TEvent extends EventObject,
>(
  resolve:
    | AgentMessage
    | AgentMessage[]
    | ((args: { context: TContext; event: TEvent }) => AgentMessage | AgentMessage[]),
): (args: { context: TContext; event: TEvent }) => AgentMessage[] {
  return (args) => {
    const resolved =
      typeof resolve === 'function' ? resolve(args) : resolve;
    return [
      ...args.context.messages,
      ...(Array.isArray(resolved) ? resolved : [resolved]),
    ];
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

// Recognized `AgentMessage` content part type tags.
const KNOWN_PART_TYPES = new Set([
  'text',
  'image',
  'file',
  'tool-call',
  'tool-result',
]);

// True if `part` is an object with a recognized part `type`.
function isKnownPart(part: unknown): part is { type: string } {
  return (
    !!part
    && typeof part === 'object'
    && KNOWN_PART_TYPES.has((part as { type?: unknown }).type as string)
  );
}

// Validates a message `content` array of parts; returns an error message, or undefined if valid.
function validatePartsArray(content: unknown): string | undefined {
  if (!Array.isArray(content)) {
    return 'Expected content to be a string or an array of parts';
  }
  for (const part of content) {
    if (!isKnownPart(part)) {
      const type =
        part && typeof part === 'object' ? (part as { type?: unknown }).type : undefined;
      return `Unknown message part type: ${JSON.stringify(type)}`;
    }
  }
  return undefined;
}

/**
 * A {@link StandardSchemaV1} validating an `AgentMessage[]` context field —
 * checks that every message has a known `role` (`system`/`user`/`assistant`/
 * `tool`) and that `content` is either a string (where the role allows it) or
 * an array of parts with a known `type`. Use it directly as a context
 * schema's `messages` field when authoring with `createAgentSchemas`.
 */
export const messagesSchema: StandardSchemaV1<AgentMessage[]> = {
  '~standard': {
    version: 1,
    vendor: 'statelyai-agent',
    validate(value: unknown) {
      if (!Array.isArray(value)) {
        return { issues: [{ message: 'Expected an array of agent messages' }] };
      }

      for (const message of value) {
        if (!message || typeof message !== 'object') {
          return { issues: [{ message: 'Expected an array of agent messages' }] };
        }

        const role = (message as { role?: unknown }).role;
        const content = (message as { content?: unknown }).content;

        if (
          role !== 'system'
          && role !== 'user'
          && role !== 'assistant'
          && role !== 'tool'
        ) {
          return {
            issues: [{ message: `Unknown message role: ${JSON.stringify(role)}` }],
          };
        }

        if (role === 'system') {
          if (typeof content !== 'string') {
            return {
              issues: [{ message: 'system message content must be a string' }],
            };
          }
          continue;
        }

        if (role === 'tool') {
          const error =
            validatePartsArray(content)
            ?? ((content as Array<{ type?: unknown }>).some(
              (part) => part.type !== 'tool-result'
            )
              ? 'tool message content must contain only tool-result parts'
              : undefined);
          if (error) {
            return { issues: [{ message: error }] };
          }
          continue;
        }

        // user | assistant: string or a parts array
        if (typeof content === 'string') {
          continue;
        }
        const error = validatePartsArray(content);
        if (error) {
          return { issues: [{ message: error }] };
        }
      }

      return { value: value as AgentMessage[] };
    },
  },
};
