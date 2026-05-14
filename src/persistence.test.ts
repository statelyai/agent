import { expect, test } from 'vitest';
import { createMemoryRunStore } from './index.js';

test('appends and loads journal events in sequence order', async () => {
  const store = createMemoryRunStore();

  const first = await store.append('session-1', {
    type: 'xstate.done.invoke.worker',
    at: 20,
  });

  const second = await store.append('session-1', {
    type: 'xstate.init',
    at: 10,
  });

  expect(first.sequence).toBe(1);
  expect(second.sequence).toBe(2);

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

test('loads the most replay-advanced saved snapshot', async () => {
  const store = createMemoryRunStore();

  await store.saveSnapshot({
    sessionId: 'session-1',
    afterSequence: 1,
    snapshot: {
      value: 'idle',
      context: { count: 1 },
      messages: [],
      status: 'active',
      createdAt: 100,
      sessionId: 'session-1',
      input: {
        idle: { count: 1 },
      },
    },
    createdAt: 100,
  });

  await store.saveSnapshot({
    sessionId: 'session-1',
    afterSequence: 3,
    snapshot: {
      value: 'done',
      context: { count: 2 },
      messages: [],
      status: 'done',
      createdAt: 300,
      sessionId: 'session-1',
      input: {
        done: { count: 2 },
      },
      output: { count: 2 },
    },
    createdAt: 300,
  });

  expect(await store.loadLatestSnapshot('session-1')).toEqual({
    sessionId: 'session-1',
    afterSequence: 3,
    snapshot: {
      value: 'done',
      context: { count: 2 },
      messages: [],
      status: 'done',
      createdAt: 300,
      sessionId: 'session-1',
      input: {
        done: { count: 2 },
      },
      output: { count: 2 },
    },
    createdAt: 300,
  });
});

test('loads the most replay-advanced snapshot even if saved earlier', async () => {
  const store = createMemoryRunStore();

  await store.saveSnapshot({
    sessionId: 'session-1',
    afterSequence: 5,
    snapshot: {
      value: 'done',
      context: { count: 5 },
      messages: [],
      status: 'done',
      createdAt: 500,
      sessionId: 'session-1',
      input: { done: { count: 5 } },
    },
    createdAt: 500,
  });

  await store.saveSnapshot({
    sessionId: 'session-1',
    afterSequence: 2,
    snapshot: {
      value: 'review',
      context: { count: 2 },
      messages: [],
      status: 'active',
      createdAt: 200,
      sessionId: 'session-1',
      input: { review: { count: 2 } },
    },
    createdAt: 200,
  });

  expect(await store.loadLatestSnapshot('session-1')).toEqual({
    sessionId: 'session-1',
    afterSequence: 5,
    snapshot: {
      value: 'done',
      context: { count: 5 },
      messages: [],
      status: 'done',
      createdAt: 500,
      sessionId: 'session-1',
      input: { done: { count: 5 } },
    },
    createdAt: 500,
  });
});
