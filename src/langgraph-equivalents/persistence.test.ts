import { expect, test, vi } from 'vitest';
import { z } from 'zod';
import {
  createAgentMachine,
  createMemoryRunStore,
  restoreSession,
  startSession,
} from '../index.js';

test('persists and restores a long-running approval workflow', async () => {
  const machine = createAgentMachine({
    id: 'langgraph-equivalent-persistence',
    context: () => ({
      approved: false,
      summary: null as string | null,
    }),
    initial: 'review',
    states: {
      review: {
        on: {
          approve: {
            target: 'summarize',
            context: { approved: true },
          },
        },
      },
      summarize: {
        schemas: { output: z.object({ summary: z.string() }) },
        invoke: async ({ context }) => ({
          summary: context.approved ? 'approved summary' : 'rejected summary',
        }),
        onDone: ({ output }) => ({
          target: 'done',
          context: { summary: output.summary },
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

  const restoredRun = await restoreSession(machine, {
    sessionId: liveRun.sessionId,
    store,
  });

  await vi.waitFor(() => {
    expect(restoredRun.getSnapshot()).toEqual(liveRun.getSnapshot());
  });

  expect(restoredRun.getSnapshot()).toEqual(
    expect.objectContaining({
      value: 'done',
      status: 'done',
      context: {
        approved: true,
        summary: 'approved summary',
      },
      output: {
        approved: true,
        summary: 'approved summary',
      },
    })
  );
});
