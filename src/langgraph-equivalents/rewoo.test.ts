import { expect, test } from 'vitest';
import { createRewooExample } from '../../examples/rewoo.js';

test('rewoo workflow plans named steps, resolves references, and synthesizes a final answer', async () => {
  const machine = createRewooExample({
    plan: async () => ({
      steps: [
        {
          id: 'E1',
          instruction: 'Find the framework',
          input: 'LangGraphJS runtime',
        },
        {
          id: 'E2',
          instruction: 'Summarize the finding',
          input: 'Use #E1 to produce a concise takeaway',
        },
      ],
    }),
    executeStep: async ({ step, resolvedInput }) => ({
      result: `${step.id}:${resolvedInput}`,
    }),
    solve: async ({ resultsById }) => ({
      answer: `${resultsById.E1} | ${resultsById.E2}`,
    }),
  });

  const result = await machine.execute(
    machine.getInitialState({ objective: 'understand the runtime' })
  );

  expect(result.status).toBe('done');
  if (result.status === 'done') {
    expect(result.output).toEqual({
      objective: 'understand the runtime',
      steps: [
        {
          id: 'E1',
          instruction: 'Find the framework',
          input: 'LangGraphJS runtime',
        },
        {
          id: 'E2',
          instruction: 'Summarize the finding',
          input: 'Use #E1 to produce a concise takeaway',
        },
      ],
      resultsById: {
        E1: 'E1:LangGraphJS runtime',
        E2: 'E2:Use E1:LangGraphJS runtime to produce a concise takeaway',
      },
      answer:
        'E1:LangGraphJS runtime | E2:Use E1:LangGraphJS runtime to produce a concise takeaway',
    });
  }
});
