import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import {
  createAgentMachine,
  createMemoryRunStore,
  startSession,
} from '../index.js';
import { waitForRunDone, waitForRunSnapshot } from './index.js';

describe('runtime helpers', () => {
  test('waitForRunSnapshot and waitForRunDone observe session lifecycle', async () => {
    const machine = createAgentMachine({
      id: 'runtime-helper-test',
      schemas: {
        events: {
          finish: z.object({ value: z.string() }),
        },
      },
      context: () => ({
        value: null as string | null,
      }),
      initial: 'waiting',
      states: {
        waiting: {
          on: {
            finish: ({ event }) => ({
              target: 'done',
              context: {
                value: event.value,
              },
            }),
          },
        },
        done: {
          type: 'final',
          output: ({ context }) => ({
            value: context.value,
          }),
        },
      },
    });

    const run = await startSession(machine, {
      store: createMemoryRunStore(),
    });
    const waiting = await waitForRunSnapshot(
      run,
      (snapshot) => snapshot.status === 'pending'
    );

    expect(waiting.value).toBe('waiting');

    const donePromise = waitForRunDone(run);
    await run.send({ type: 'finish', value: 'ok' });

    await expect(donePromise).resolves.toEqual(
      expect.objectContaining({
        output: {
          value: 'ok',
        },
      })
    );
  });
});
