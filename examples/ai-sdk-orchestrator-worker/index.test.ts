import { test } from 'vitest';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { runAgent } from '../../src/index.js';
import { aiSdkOrchestratorWorkerMachine } from './index.js';

const fileChangeSchema = z.object({
  filePath: z.string(),
  changeType: z.enum(['create', 'modify', 'delete']),
  explanation: z.string(),
  code: z.string(),
});

test('AI SDK orchestrator-worker maps to an explicit machine', async () => {
  const result = await runAgent(aiSdkOrchestratorWorkerMachine, {
    input: { featureRequest: 'Add settings page' },
    generateText: async () => ({
      output: {
        files: [
          {
            purpose: 'Add UI',
            filePath: 'app/page.tsx',
            changeType: 'modify',
          },
          {
            purpose: 'Add test',
            filePath: 'app/page.test.tsx',
            changeType: 'create',
          },
        ],
        estimatedComplexity: 'medium',
      },
    }),
  });
  assert.equal(result.status, 'done');
  assert.deepEqual(
    result.status === 'done'
      ? result.output.changes.map((change: z.infer<typeof fileChangeSchema>) =>
        change.filePath,
      )
      : [],
    ['app/page.tsx', 'app/page.test.tsx'],
  );
});
