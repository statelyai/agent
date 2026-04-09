import { expect, test } from 'vitest';
import { createAgentMachine } from './index.js';

const machine = createAgentMachine({
  id: 'snapshot-machine',
  context: () => ({}),
  initial: () => ({
    target: 'done',
    params: { step: 1 },
  }),
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
  expect(snaps[0]!.params).toEqual({ done: { step: 1 } });
  expect(snaps[0]).toEqual(
    expect.objectContaining({
      sessionId: expect.any(String),
      createdAt: expect.any(Number),
      value: 'done',
      context: {},
      status: 'active',
      params: { done: { step: 1 } },
    })
  );
  expect(snaps[snaps.length - 1]).toEqual(
    expect.objectContaining({
      sessionId: snaps[0]!.sessionId,
      createdAt: snaps[0]!.createdAt,
      value: 'done',
      context: {},
      status: 'done',
      params: { done: { step: 1 } },
      output: { ok: true },
    })
  );
});

test('snapshot roundtrips through resolveState without losing identity', async () => {
  const emitted = await collectSnapshots();
  const restored = machine.resolveState(emitted[0]!);
  const rerun = await collectSnapshots(restored);

  expect(restored.sessionId).toBe(emitted[0]!.sessionId);
  expect(restored.createdAt).toBe(emitted[0]!.createdAt);
  expect(restored.params).toEqual(emitted[0]!.params);
  expect(rerun[0]!.sessionId).toBe(emitted[0]!.sessionId);
  expect(rerun[0]!.createdAt).toBe(emitted[0]!.createdAt);
  expect(rerun[0]!.params).toEqual(emitted[0]!.params);
});

test('fresh machine executions on the same raw state get distinct session ids', async () => {
  const state = machine.getInitialState();
  const firstRun = await collectSnapshots(state);
  const secondRun = await collectSnapshots(state);

  expect(firstRun[0]!.sessionId).not.toBe(secondRun[0]!.sessionId);
});
