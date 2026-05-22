import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { createAiSdkAdapter, createAiSdkDecisionAdapter } from './index.js';

describe('createAiSdkAdapter', () => {
  test('resolves schema-less choices with a custom model resolver', async () => {
    const seen: Array<{ model: unknown; prompt: unknown }> = [];
    const adapter = createAiSdkDecisionAdapter({
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
    const adapter = createAiSdkDecisionAdapter({
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

  test('creates a generation-only machine adapter', async () => {
    const adapter = createAiSdkAdapter({
      generateText: async (options) =>
        ({
          text: `generated ${options.prompt}`,
        }) as never,
    });

    await expect(
      adapter.generateText?.({
        model: 'openai/gpt-5.4-nano',
        messages: [],
        prompt: 'reply',
      })
    ).resolves.toBe('generated reply');
    expect('decide' in adapter).toBe(false);
  });

  test('does not send prompt and messages together', async () => {
    const seen: Array<{ prompt?: unknown; messages?: unknown }> = [];
    const adapter = createAiSdkAdapter({
      generateText: async (options) => {
        seen.push({
          prompt: options.prompt,
          messages: options.messages,
        });

        return { text: 'ok' } as never;
      },
    });

    await adapter.generateText?.({
      model: 'openai/gpt-5.4-nano',
      prompt: 'reply',
      messages: [{ role: 'user', content: 'reply' }],
    });

    expect(seen).toEqual([
      {
        prompt: undefined,
        messages: [{ role: 'user', content: 'reply' }],
      },
    ]);
  });
});
