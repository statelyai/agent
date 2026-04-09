import { expect, test } from 'vitest';
import { createAgentMachine } from './index.js';

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

async function collectSnapshots(state = machine.getInitialState()) {
  const snaps = [];
  for await (const snap of machine.stream(state)) {
    snaps.push(snap);
  }

  return snaps;
}

test('stream emits durable snapshots with stable session metadata', async () => {
  const snaps = await collectSnapshots();

  expect(snaps.length).toBeGreaterThanOrEqual(2);
  expect(new Set(snaps.map((snap) => snap.sessionId)).size).toBe(1);
  expect(new Set(snaps.map((snap) => snap.createdAt)).size).toBe(1);
  expect(snaps[0]).toEqual(
    expect.objectContaining({
      sessionId: expect.any(String),
      createdAt: expect.any(Number),
      value: 'done',
      context: {},
      status: 'active',
    })
  );
  expect(snaps[0]).not.toHaveProperty('params');
  expect(snaps[snaps.length - 1]).toEqual(
    expect.objectContaining({
      sessionId: snaps[0]!.sessionId,
      createdAt: snaps[0]!.createdAt,
      value: 'done',
      context: {},
      status: 'done',
      output: { ok: true },
    })
  );
});

test('separate machine executions get distinct session ids', async () => {
  const state = machine.getInitialState();
  const firstRun = await collectSnapshots(state);
  const secondRun = await collectSnapshots(state);

  expect(firstRun[0]!.sessionId).not.toBe(secondRun[0]!.sessionId);
  expect(firstRun[0]!.createdAt).not.toBe(secondRun[0]!.createdAt);
});
