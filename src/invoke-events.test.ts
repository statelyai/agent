import { expect, test } from 'vitest';
import { z } from 'zod';
import {
  createAgentMachine,
  createMemoryRunStore,
  startSession,
} from './index.js';

test('invoke success is journaled as an internal machine event', async () => {
  const machine = createAgentMachine({
    id: 'invoke-success',
    context: () => ({ result: null as string | null }),
    initial: 'processing',
    states: {
      processing: {
        resultSchema: z.object({ value: z.string() }),
        invoke: async () => ({ value: 'ok' }),
        onDone: ({ result }) => ({
          target: 'done',
          context: { result: result.value },
        }),
      },
      done: {
        type: 'final',
        output: ({ context }) => context,
      },
    },
  });

  const store = createMemoryRunStore();
  const run = await startSession(machine, { store });
  const journal = await store.loadEvents(run.sessionId);

  expect(run.getSnapshot()).toEqual(
    expect.objectContaining({
      value: 'done',
      status: 'done',
      context: { result: 'ok' },
      output: { result: 'ok' },
    })
  );
  expect(journal).toEqual([
    expect.objectContaining({ sequence: 1, type: 'xstate.init' }),
    expect.objectContaining({
      sequence: 2,
      type: 'xstate.done.invoke.processing',
      output: { value: 'ok' },
    }),
  ]);
});

test('invoke failure is journaled as an internal machine event', async () => {
  const machine = createAgentMachine({
    id: 'invoke-failure',
    context: () => ({ count: 0 }),
    initial: 'processing',
    states: {
      processing: {
        invoke: async () => {
          throw new Error('boom');
        },
      },
    },
  });

  const store = createMemoryRunStore();
  const run = await startSession(machine, { store });
  const journal = await store.loadEvents(run.sessionId);

  expect(run.getSnapshot()).toEqual(
    expect.objectContaining({
      value: 'processing',
      status: 'error',
      context: { count: 0 },
      error: expect.objectContaining({ message: 'boom' }),
    })
  );
  expect(journal).toEqual([
    expect.objectContaining({ sequence: 1, type: 'xstate.init' }),
    expect.objectContaining({
      sequence: 2,
      type: 'xstate.error.invoke.processing',
      error: expect.objectContaining({ message: 'boom' }),
    }),
  ]);
});
