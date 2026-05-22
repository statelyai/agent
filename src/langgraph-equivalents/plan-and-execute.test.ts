import { describe, expect, test, vi } from 'vitest';
import { execute, invoke, stream } from '../local/index.js';
import { createPlanAndExecuteExample } from '../../examples/plan-and-execute.js';

test('plan-and-execute workflow decomposes a goal and synthesizes a final answer', async () => {
  const machine = createPlanAndExecuteExample({
    plan: async () => ({
      plan: ['inspect docs', 'inspect code', 'summarize findings'],
    }),
    executeStep: async ({ step }) => ({
      result: `done:${step}`,
    }),
    synthesize: async ({ stepResults }) => ({
      answer: stepResults.join(' | '),
    }),
  });

  const result = await execute(machine, 
    machine.getInitialState({ goal: 'understand the repo' })
  );

  expect(result.status).toBe('done');
  if (result.status === 'done') {
    expect(result.output).toEqual({
      goal: 'understand the repo',
      plan: ['inspect docs', 'inspect code', 'summarize findings'],
      stepResults: [
        'done:inspect docs',
        'done:inspect code',
        'done:summarize findings',
      ],
      answer:
        'done:inspect docs | done:inspect code | done:summarize findings',
    });
  }
});
