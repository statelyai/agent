import { expect, test } from 'vitest';
import { createErrorRetryExample } from '../../examples/index.js';

test('retries failed invoke work through explicit internal error events', async () => {
  let attempts = 0;
  const machine = createErrorRetryExample(async ({ attempt }) => {
    attempts += 1;

    if (attempt < 3) {
      throw new Error(`temporary failure ${attempt}`);
    }

    return {
      answer: `answered on attempt ${attempt}`,
    };
  });

  const result = await machine.execute(
    machine.getInitialState({ question: 'What is durable retry?' })
  );

  expect(attempts).toBe(3);
  expect(result.status).toBe('done');
  if (result.status === 'done') {
    expect(result.output).toEqual({
      answer: 'answered on attempt 3',
      attempts: 3,
      errors: ['temporary failure 1', 'temporary failure 2'],
    });
  }
});

test('fails after the configured retry budget is exhausted', async () => {
  const machine = createErrorRetryExample(async ({ attempt }) => {
    throw new Error(`still down ${attempt}`);
  }, 2);

  const result = await machine.execute(
    machine.getInitialState({ question: 'Will this recover?' })
  );

  expect(result.status).toBe('done');
  if (result.status === 'done') {
    expect(result.output).toEqual({
      answer: null,
      attempts: 2,
      errors: ['still down 1', 'still down 2'],
    });
  }
});
