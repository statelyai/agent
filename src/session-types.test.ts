import { expect, test } from 'vitest';
import type { AgentSnapshot, JournalEvent } from './index.js';

test('AgentSnapshot includes durable session fields', () => {
  const snapshot: AgentSnapshot<{ count: number }, 'idle'> = {
    value: 'idle',
    context: { count: 1 },
    status: 'active',
    createdAt: 123,
    sessionId: 'session-1',
    params: {},
  };

  expect(snapshot.sessionId).toBe('session-1');
  expect(snapshot.createdAt).toBe(123);
});

test('JournalEvent supports invoke completion events', () => {
  const event: JournalEvent = {
    type: 'xstate.done.invoke.worker',
    at: 456,
  };

  expect(event.type).toBe('xstate.done.invoke.worker');
  expect(event.at).toBe(456);
});
