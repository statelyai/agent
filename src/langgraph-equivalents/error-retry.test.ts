import { expect, test, vi } from 'vitest';
import { createErrorRetryExample } from '../../examples/index.js';
import { createMemoryRunStore, restoreSession } from '../index.js';

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

test('restores a durable retry snapshot and continues from the next attempt', async () => {
  const sessionId = 'durable-retry-session';
  const machine = createErrorRetryExample(async ({ attempt }) => ({
    answer: `restored attempt ${attempt}`,
  }));
  const store = createMemoryRunStore();
  const input = { question: 'Can retry survive restore?' };
  const initial = machine.getInitialState(input);
  const retryState = machine.transition(initial, {
    type: 'xstate.error.invoke.answering',
    error: { message: 'network reset' },
    at: 2,
  });

  await store.append(sessionId, {
    type: 'xstate.init',
    input,
    at: 1,
  });
  await store.append(sessionId, {
    type: 'xstate.error.invoke.answering',
    error: { message: 'network reset' },
    at: 2,
  });
  await store.saveSnapshot({
    sessionId,
    afterSequence: 2,
    snapshot: {
      value: retryState.value,
      context: retryState.context,
      messages: retryState.messages,
      status: retryState.status,
      input: retryState.input,
      createdAt: 1,
      sessionId,
    },
    createdAt: 2,
  });

  const restored = await restoreSession(machine, {
    sessionId,
    store,
  });

  await vi.waitFor(() => {
    expect(restored.getSnapshot().status).toBe('done');
  });

  expect(restored.getSnapshot()).toEqual(
    expect.objectContaining({
      value: 'done',
      status: 'done',
      context: {
        question: 'Can retry survive restore?',
        answer: 'restored attempt 2',
        attempt: 2,
        errors: ['network reset'],
      },
      output: {
        answer: 'restored attempt 2',
        attempts: 2,
        errors: ['network reset'],
      },
    })
  );
});
