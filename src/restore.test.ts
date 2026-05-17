import { expect, test, vi } from 'vitest';
import { z } from 'zod';
import {
  createAgentMachine,
  createMemoryRunStore,
  restoreSession,
  startSession,
} from './index.js';

test('restoreSession reconstructs from the latest snapshot plus replay tail', async () => {
  const machine = createAgentMachine({
    id: 'restore-session',
    context: () => ({ approved: false, result: null as string | null }),
    initial: 'review',
    states: {
      review: {
        on: {
          approve: {
            target: 'processing',
            context: { approved: true },
          },
        },
      },
      processing: {
        schemas: { output: z.object({ value: z.string() }) },
        invoke: async ({ context }) => ({
          value: context.approved ? 'approved' : 'rejected',
        }),
        onDone: ({ output }) => ({
          target: 'done',
          context: { result: output.value },
        }),
      },
      done: {
        type: 'final',
        output: ({ context }) => context,
      },
    },
  });

  const baseStore = createMemoryRunStore();
  let snapshotWrites = 0;
  const store = {
    append: baseStore.append,
    loadEvents: baseStore.loadEvents,
    loadLatestSnapshot: baseStore.loadLatestSnapshot,
    async saveSnapshot(snapshot: Awaited<
      ReturnType<typeof baseStore.loadLatestSnapshot>
    > extends infer TSaved
      ? Exclude<TSaved, null>
      : never) {
      snapshotWrites += 1;
      if (snapshotWrites === 1) {
        await baseStore.saveSnapshot(snapshot);
      }
    },
  };

  const liveRun = await startSession(machine, { store });
  await liveRun.send({ type: 'approve' });

  expect(await store.loadLatestSnapshot(liveRun.sessionId)).toEqual(
    expect.objectContaining({
      afterSequence: 1,
    })
  );

  const restoredRun = await restoreSession(machine, {
    sessionId: liveRun.sessionId,
    store,
  });
  await vi.waitFor(() => {
    expect(restoredRun.getSnapshot()).toEqual(liveRun.getSnapshot());
  });

  expect(restoredRun.getSnapshot()).toEqual(liveRun.getSnapshot());
});
