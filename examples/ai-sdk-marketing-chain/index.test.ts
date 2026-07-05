import { test } from 'vitest';
import assert from 'node:assert/strict';
import { runAgent } from '../../src/index.js';
import { aiSdkMarketingChainMachine } from './index.js';

test('AI SDK marketing chain maps to an explicit machine', async () => {
  let calls = 0;
  const result = await runAgent(aiSdkMarketingChainMachine, {
    input: { product: 'state machines' },
    generateText: async (request) => {
      calls += 1;
      if (calls === 1) {
        return { output: 'Buy state machines' };
      }
      if (calls === 2) {
        return {
          output: {
            hasCallToAction: false,
            emotionalAppeal: 5,
            clarity: 6,
          },
        };
      }
      return { output: 'Buy state machines. Start today.' };
    },
  });
  assert.equal(result.status, 'done');
  assert.equal(
    result.status === 'done' ? result.output.copy : undefined,
    'Buy state machines. Start today.',
  );
});
