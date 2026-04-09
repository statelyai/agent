import { expect, test } from 'vitest';
import { createAgentMachine } from './index.js';

test('stream emits durable snapshots with session metadata', async () => {
  const machine = createAgentMachine({
    id: 'snapshot-machine',
    context: () => ({}),
    initial: 'done',
    states: {
      done: {
        type: 'final',
        output: () => ({ ok: true }),
      },
    },
  });

  const snaps = [];
  for await (const snap of machine.stream(machine.getInitialState())) {
    snaps.push(snap);
  }

  expect(snaps.length).toBeGreaterThanOrEqual(2);
  expect(snaps[0]).toEqual(
    expect.objectContaining({
      sessionId: 'snapshot-machine',
      createdAt: expect.any(Number),
      value: 'done',
      context: {},
      status: 'active',
    })
  );
  expect(snaps[0]).not.toHaveProperty('params');
  expect(snaps[snaps.length - 1]).toEqual(
    expect.objectContaining({
      sessionId: 'snapshot-machine',
      createdAt: expect.any(Number),
      value: 'done',
      context: {},
      status: 'done',
      output: { ok: true },
    })
  );
});
