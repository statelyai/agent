import { test } from 'vitest';
import assert from 'node:assert/strict';
import { runAgent } from '../../src/index.js';
import { aiSdkParallelReviewMachine } from './index.js';

test('AI SDK parallel review maps to an explicit machine', async () => {
  const output = await runAgent(aiSdkParallelReviewMachine, {
    input: { code: 'const x = eval(input);' },
    generateText: async (request) =>
      JSON.parse(request.prompt ?? '[]')
        .map((review: { type: string }) => review.type)
        .join(','),
  });
  assert.equal(
    output.summary,
    'security,performance,maintainability',
  );
});
