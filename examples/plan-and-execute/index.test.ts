import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { AgentTextRequest } from '../../src/index.js';
import { runPlanAndExecuteExample } from './index.js';

test('plan-and-execute plans steps, gathers per-step evidence, and solves from the map', async () => {
  const workerQuestions: string[] = [];
  const output = await runPlanAndExecuteExample({
    input: { goal: 'Compare two libraries.' },
    generateText: async (request: AgentTextRequest) => {
      if (request.model === 'planner') {
        return {
          output: {
            steps: [
              { id: 'E1', question: 'What is library A?' },
              { id: 'E2', question: 'What is library B?' },
            ],
          },
        };
      }
      if (request.model === 'worker') {
        workerQuestions.push(request.prompt ?? '');
        return { output: `evidence for: ${request.prompt}` };
      }
      // solver — its prompt embeds the whole evidence map.
      assert.ok(request.prompt?.includes('E1:'));
      assert.ok(request.prompt?.includes('E2:'));
      return { output: 'final answer from evidence' };
    },
  });

  // Both plan steps were executed, in order, via the worker.
  assert.deepEqual(workerQuestions, [
    'What is library A?',
    'What is library B?',
  ]);
  // Evidence is retained per step id (the ReWOO evidence map).
  assert.deepEqual(output.evidence, {
    E1: 'evidence for: What is library A?',
    E2: 'evidence for: What is library B?',
  });
  assert.deepEqual(
    output.steps.map((step) => step.id),
    ['E1', 'E2'],
  );
  assert.ok(output.answer.startsWith('final answer'));
});
