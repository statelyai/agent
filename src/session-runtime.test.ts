import { expect, test } from 'vitest';
import {
  createAgentMachine,
  createMemoryRunStore,
  startSession,
} from './index.js';

test('startSession creates a session and persists xstate.init', async () => {
  const machine = createAgentMachine({
    id: 'session-runtime',
    context: () => ({ count: 0 }),
    initial: 'idle',
    states: {
      idle: {
        on: {
          increment: {
            target: 'done',
            context: { count: 1 },
          },
        },
      },
      done: {
        type: 'final',
        output: ({ context }) => context,
      },
    },
  });

  const store = createMemoryRunStore();
  const run = await startSession(machine, { store });
  const snapshot = run.getSnapshot();
  const journal = await store.loadEvents(run.sessionId);
  const persisted = await store.loadLatestSnapshot(run.sessionId);

  expect(run.sessionId).toBe(snapshot.sessionId);
  expect(run.status).toBe('pending');
  expect(snapshot).toEqual(
    expect.objectContaining({
      sessionId: run.sessionId,
      value: 'idle',
      status: 'pending',
      context: { count: 0 },
      params: {},
    })
  );
  expect(journal).toEqual([
    expect.objectContaining({
      sequence: 1,
      type: 'xstate.init',
      at: expect.any(Number),
    }),
  ]);
  expect(persisted).toEqual(
    expect.objectContaining({
      sessionId: run.sessionId,
      afterSequence: 1,
      snapshot,
    })
  );
});
