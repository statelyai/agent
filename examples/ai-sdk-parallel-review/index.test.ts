import { test } from 'vitest';
import assert from 'node:assert/strict';
import { runAgent } from '../../src/index.js';
import { aiSdkParallelReviewMachine } from './index.js';

test('AI SDK parallel review maps to an explicit machine', async () => {
  const result = await runAgent(aiSdkParallelReviewMachine, {
    input: { code: 'const x = eval(input);' },
    generateText: async (request) => ({
      output: JSON.parse(request.prompt ?? '[]')
        .map((review: { type: string }) => review.type)
        .join(','),
    }),
  });
  assert.equal(result.status, 'done');
  assert.equal(
    result.status === 'done' ? result.output.summary : undefined,
    'security,performance,maintainability',
  );
});
