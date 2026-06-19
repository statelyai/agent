import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { createAiSdkAdapter, toAiSdkGenerateTextOptions, toAiSdkTools } from './index.js';
import type { StandardSchemaV1 } from '../types.js';

describe('createAiSdkAdapter', () => {
  test('creates a generation-only machine adapter', async () => {
    const adapter = createAiSdkAdapter({
      generateText: async (options) =>
        ({
          text: `generated ${options.prompt}`,
        }) as never,
    });

    await expect(
      adapter.generateText?.({
        modelRef: 'openai/gpt-5.4-nano',
        messages: [],
        prompt: 'reply',
      })
    ).resolves.toBe('generated reply');
    expect('decide' in adapter).toBe(false);
  });

  test('passes standard JSON schemas through to AI SDK output', async () => {
    const outputSchema = standardJsonSchema({
      type: 'object',
      properties: { answer: { type: 'string' } },
      required: ['answer'],
      additionalProperties: false,
    });

    const options = toAiSdkGenerateTextOptions({
      modelRef: 'openai/gpt-5.4-nano',
      messages: [],
      prompt: 'reply',
      outputSchema,
    });

    await expect(options.output?.responseFormat).resolves.toEqual({
      type: 'json',
      schema: {
        type: 'object',
        properties: { answer: { type: 'string' } },
        required: ['answer'],
        additionalProperties: false,
      },
    });
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
      modelRef: 'openai/gpt-5.4-nano',
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

  test('converts agent tool descriptors to AI SDK tools', () => {
    const inputSchema = z.object({ target: z.string() });
    const tools = toAiSdkTools({
      'event.ATTACK': {
        description: 'Attack a target.',
        inputSchema,
        execute: async (input) => ({ type: 'ATTACK', ...input as object }),
      },
    });

    expect(tools['event.ATTACK']).toEqual(
      expect.objectContaining({
        description: 'Attack a target.',
        inputSchema,
        execute: expect.any(Function),
      })
    );
  });
});

function standardJsonSchema(jsonSchema: Record<string, unknown>): StandardSchemaV1 {
  return {
    '~standard': {
      version: 1,
      vendor: 'test',
      validate: (value: unknown) => ({ value }),
      jsonSchema: {
        input: () => jsonSchema,
      },
    },
  } as unknown as StandardSchemaV1;
}
