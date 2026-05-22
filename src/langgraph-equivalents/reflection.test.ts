import { describe, expect, test, vi } from 'vitest';
import { execute, invoke, stream } from '../local/index.js';
import { createReflectionExample } from '../../examples/reflection.js';

test('reflection workflow revises a draft until critique is cleared', async () => {
  const machine = createReflectionExample({
    draft: async () => ({
      draft: 'Initial draft',
    }),
    reflect: async ({ revisionCount }) => ({
      feedback: revisionCount === 0 ? 'Add more detail.' : null,
    }),
    revise: async ({ draft, feedback }) => ({
      draft: `${draft} Revised: ${feedback}`,
    }),
  });

  const result = await execute(machine, 
    machine.getInitialState({ task: 'Write a short explanation.' })
  );

  expect(result.status).toBe('done');
  if (result.status === 'done') {
    expect(result.output).toEqual({
      task: 'Write a short explanation.',
      draft: 'Initial draft Revised: Add more detail.',
      feedback: null,
      revisionCount: 1,
    });
  }
});
