import { test } from 'vitest';
import assert from 'node:assert/strict';
import { runAgent } from '../../src/index.js';
import { aiSdkRoutingMachine } from './index.js';

test('AI SDK routing maps to an explicit machine', async () => {
  const routedModels: string[] = [];
  const output = await runAgent(aiSdkRoutingMachine, {
    input: { query: 'The app crashes on launch.' },
    generateText: async (request) => {
      if (request.prompt?.startsWith('Classify this customer query:')) {
        return {
          reasoning: 'needs troubleshooting',
          type: 'technical',
          complexity: 'complex',
        };
      }
      routedModels.push(request.model);
      return `technical:${request.prompt}`;
    },
  });
  assert.deepEqual(routedModels, ['openai/o4-mini']);
  assert.equal(
    output.response,
    'technical:The app crashes on launch.',
  );
});
