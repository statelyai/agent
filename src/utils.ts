import type { AgentMessage, StandardSchemaV1 } from './types.js';

export function userMessage(content: string): AgentMessage {
  return { role: 'user', content };
}

export function assistantMessage(content: string): AgentMessage {
  return { role: 'assistant', content };
}

export function systemMessage(content: string): AgentMessage {
  return { role: 'system', content };
}

export function appendMessages(
  messages: AgentMessage[],
  next: AgentMessage | AgentMessage[]
): AgentMessage[] {
  return messages.concat(Array.isArray(next) ? next : [next]);
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
