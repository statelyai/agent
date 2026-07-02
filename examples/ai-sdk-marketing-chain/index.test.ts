import { test } from 'vitest';
import assert from 'node:assert/strict';
import { runAgent } from '../../src/index.js';
import { aiSdkMarketingChainMachine } from './index.js';

test('AI SDK marketing chain maps to an explicit machine', async () => {
  let calls = 0;
  const output = await runAgent(aiSdkMarketingChainMachine, {
    input: { product: 'state machines' },
    generateText: async (request) => {
      calls += 1;
      if (calls === 1) {
        return 'Buy state machines';
      }
      if (calls === 2) {
        return {
          hasCallToAction: false,
          emotionalAppeal: 5,
          clarity: 6,
        };
      }
      return 'Buy state machines. Start today.';
    },
  });
  assert.equal(output.copy, 'Buy state machines. Start today.');
});
