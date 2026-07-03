import type {
  AssistantMessage,
  FilePart,
  ImagePart,
  StandardSchemaV1,
  SystemMessage,
  TextPart,
  ToolCallPart,
  ToolMessage,
  ToolResultPart,
  UserMessage,
} from './types.js';

/** Builds a {@link UserMessage} from a string or multimodal content parts. */
export function userMessage(
  content: string | Array<TextPart | ImagePart | FilePart>
): UserMessage {
  return { role: 'user', content };
}

/** Builds an {@link AssistantMessage} from a string or content parts (text, files, tool calls/results). */
export function assistantMessage(
  content: string | Array<TextPart | FilePart | ToolCallPart | ToolResultPart>
): AssistantMessage {
  return { role: 'assistant', content };
}

/** Builds a {@link SystemMessage}. */
export function systemMessage(content: string): SystemMessage {
  return { role: 'system', content };
}

/** Builds a {@link ToolMessage} from one or more tool-result parts. */
export function toolMessage(content: Array<ToolResultPart>): ToolMessage {
  return { role: 'tool', content };
}

/**
 * Validates `value` against a {@link StandardSchemaV1}, synchronously.
 * Throws if the schema's `validate` returns a `Promise` (async validation is
 * not supported anywhere in this library) or if validation reports issues —
 * in which case the thrown `Error.message` joins every issue message with
 * `', '`.
 */
export function validateSchemaSync<T>(
  schema: StandardSchemaV1<T>,
  value: unknown
): T {
  const result = schema['~standard'].validate(value);
  if (result instanceof Promise) {
    throw new Error('Async schema validation is not supported.');
  }

  if (result.issues) {
    throw new Error(
      result.issues.map((issue: { message: string }) => issue.message).join(', ')
    );
  }

  return result.value as T;
}
