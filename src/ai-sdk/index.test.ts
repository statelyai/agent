import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { toAiSdkTools } from './index.js';

describe('toAiSdkTools', () => {
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
