import { describe, expect, test, vi } from 'vitest';
import { execute, invoke, stream } from '../local/index.js';
import { createConditionalSubflowExample } from '../../examples/index.js';

test('conditionally enters the research subflow from parent input', async () => {
  const machine = createConditionalSubflowExample({
    research: async (topic) => ({
      bullets: [`${topic}:fact-1`, `${topic}:fact-2`],
    }),
  });

  const result = await execute(machine, 
    machine.getInitialState({
      topic: 'agent graphs',
      mode: 'research',
    })
  );

  expect(result.status).toBe('done');
  if (result.status === 'done') {
    expect(result.output).toEqual({
      mode: 'research',
      bullets: ['agent graphs:fact-1', 'agent graphs:fact-2'],
      draft: null,
    });
  }
});

test('conditionally enters the draft subflow with parent-provided input', async () => {
  const machine = createConditionalSubflowExample({
    draft: async ({ topic, bullets }) => ({
      draft: `${topic}: ${bullets.join(' / ')}`,
    }),
  });

  const result = await execute(machine, 
    machine.getInitialState({
      topic: 'agent graphs',
      mode: 'draft',
      bullets: ['known fact', 'second fact'],
    })
  );

  expect(result.status).toBe('done');
  if (result.status === 'done') {
    expect(result.output).toEqual({
      mode: 'draft',
      bullets: ['known fact', 'second fact'],
      draft: 'agent graphs: known fact / second fact',
    });
  }
});
