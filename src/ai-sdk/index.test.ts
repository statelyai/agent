import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { createAiSdkAdapter } from './index.js';

describe('createAiSdkAdapter', () => {
  test('resolves schema-less choices with a custom model resolver', async () => {
    const seen: Array<{ model: unknown; prompt: unknown }> = [];
    const adapter = createAiSdkAdapter({
      resolveModel: (model) => ({ providerResolved: model }) as never,
      generateText: async (options) => {
        seen.push({
          model: options.model,
          prompt: options.prompt,
        });

        return {
          output: 'billing',
        } as never;
      },
    });

    const result = await adapter.decide({
      model: 'openai/gpt-5.4-nano',
      prompt: 'Refund request for last month.',
      options: {
        billing: { description: 'Billing support' },
        general: { description: 'General support' },
      },
    });

    expect(result).toEqual({
      choice: 'billing',
      data: {},
    });
    expect(seen).toEqual([
      {
        model: { providerResolved: 'openai/gpt-5.4-nano' },
        prompt: 'Refund request for last month.',
      },
    ]);
  });

  test('returns structured decision payloads for schema-backed options', async () => {
    const adapter = createAiSdkAdapter({
      generateText: async () =>
        ({
          output: {
            decision: 'research',
            data: {
              query: 'latest cloudflare agents docs',
            },
            reasoning: 'Need the newest API details.',
          },
        }) as never,
    });

    const result = await adapter.decide({
      model: 'openai/gpt-5.4-nano',
      prompt: 'Find the current Cloudflare Agents docs.',
      reasoning: true,
      options: {
        research: {
          description: 'Do external research first.',
          schema: z.object({
            query: z.string(),
          }),
        },
        answer: {
          description: 'Answer directly.',
        },
      },
    });

    expect(result).toEqual({
      choice: 'research',
      data: {
        query: 'latest cloudflare agents docs',
      },
      reasoning: 'Need the newest API details.',
    });
  });
});
