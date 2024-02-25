import { LLMProvider } from './openai';

export function createMockProvider(
  create: LLMProvider['chat']['completions']['create']
): LLMProvider {
  return {
    chat: {
      completions: {
        create,
      },
    },
  };
}
