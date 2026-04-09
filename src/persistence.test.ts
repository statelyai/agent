import { expect, test } from 'vitest';
import { createMemoryRunStore } from './index.js';

test('appends and loads journal events in sequence order', async () => {
  const store = createMemoryRunStore();

  await store.append('session-1', [
    {
      sessionId: 'session-1',
      sequence: 2,
      type: 'xstate.done.invoke.worker',
      at: 20,
    },
    {
      sessionId: 'session-1',
      sequence: 1,
      type: 'xstate.init',
      at: 10,
    },
  ]);

  expect(await store.loadEvents('session-1')).toEqual([
    {
      sessionId: 'session-1',
      sequence: 1,
      type: 'xstate.init',
      at: 10,
    },
    {
      sessionId: 'session-1',
      sequence: 2,
      type: 'xstate.done.invoke.worker',
      at: 20,
    },
  ]);
});

test('loads the latest saved snapshot', async () => {
  const store = createMemoryRunStore();

  await store.saveSnapshot({
    sessionId: 'session-1',
    sequence: 1,
    snapshot: {
      value: 'idle',
      context: { count: 1 },
      status: 'active',
      createdAt: 100,
      sessionId: 'session-1',
    },
    lastJournalIndex: 1,
    createdAt: 100,
  });

  await store.saveSnapshot({
    sessionId: 'session-1',
    sequence: 3,
    snapshot: {
      value: 'done',
      context: { count: 2 },
      status: 'done',
      createdAt: 300,
      sessionId: 'session-1',
      output: { count: 2 },
    },
    lastJournalIndex: 3,
    createdAt: 300,
  });

  expect(await store.loadLatestSnapshot('session-1')).toEqual({
    sessionId: 'session-1',
    sequence: 3,
    snapshot: {
      value: 'done',
      context: { count: 2 },
      status: 'done',
      createdAt: 300,
      sessionId: 'session-1',
      output: { count: 2 },
    },
    lastJournalIndex: 3,
    createdAt: 300,
  });
});
