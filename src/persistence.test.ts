import { expect, test } from 'vitest';
import { createMemoryRunStore } from './index.js';

test('appends and loads journal events in sequence order', async () => {
  const store = createMemoryRunStore();

  await store.append('session-1', {
    type: 'xstate.done.invoke.worker',
    at: 20,
  });

  await store.append('session-1', {
    type: 'xstate.init',
    at: 10,
  });

  expect(await store.loadEvents('session-1')).toEqual([
    {
      sequence: 1,
      type: 'xstate.done.invoke.worker',
      at: 20,
    },
    {
      sequence: 2,
      type: 'xstate.init',
      at: 10,
    },
  ]);

  expect(await store.loadEvents('session-1', 1)).toEqual([
    {
      sequence: 2,
      at: 10,
      type: 'xstate.init',
    },
  ]);
});

test('loads the latest saved snapshot', async () => {
  const store = createMemoryRunStore();

  await store.saveSnapshot({
    sessionId: 'session-1',
    sequence: 1,
    afterSequence: 1,
    snapshot: {
      value: 'idle',
      context: { count: 1 },
      status: 'active',
      createdAt: 100,
      sessionId: 'session-1',
      params: {
        idle: { count: 1 },
      },
    },
    createdAt: 100,
  });

  await store.saveSnapshot({
    sessionId: 'session-1',
    sequence: 3,
    afterSequence: 3,
    snapshot: {
      value: 'done',
      context: { count: 2 },
      status: 'done',
      createdAt: 300,
      sessionId: 'session-1',
      params: {
        done: { count: 2 },
      },
      output: { count: 2 },
    },
    createdAt: 300,
  });

  expect(await store.loadLatestSnapshot('session-1')).toEqual({
    sessionId: 'session-1',
    sequence: 3,
    afterSequence: 3,
    snapshot: {
      value: 'done',
      context: { count: 2 },
      status: 'done',
      createdAt: 300,
      sessionId: 'session-1',
      params: {
        done: { count: 2 },
      },
      output: { count: 2 },
    },
    createdAt: 300,
  });
});
