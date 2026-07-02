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

export function userMessage(
  content: string | Array<TextPart | ImagePart | FilePart>
): UserMessage {
  return { role: 'user', content };
}

export function assistantMessage(
  content: string | Array<TextPart | FilePart | ToolCallPart | ToolResultPart>
): AssistantMessage {
  return { role: 'assistant', content };
}

export function systemMessage(content: string): SystemMessage {
  return { role: 'system', content };
}

export function toolMessage(content: Array<ToolResultPart>): ToolMessage {
  return { role: 'tool', content };
}

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
