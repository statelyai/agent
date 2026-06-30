import assert from 'node:assert/strict';
import { z } from 'zod';
import { createActor, createAsyncLogic, toPromise, waitFor } from 'xstate';
import { setupAgent } from '../../src/index.js';

export async function runBurrCounterExample() {
  const agent = setupAgent({
    context: z.object({ counter: z.number(), countUpTo: z.number() }),
    input: z.object({ countUpTo: z.number() }),
    output: z.object({ counter: z.number() }),
    actors: {
      increment: createAsyncLogic<number, { counter: number }>({
        run: async ({ input }) => input.counter + 1,
      }),
    },
  });

  const machine = agent.createMachine({
    id: 'burr-counter-xstate',
    context: ({ input }) => ({ counter: 0, countUpTo: input.countUpTo }),
    initial: 'counter',
    states: {
      counter: {
        invoke: {
          src: 'increment',
          input: ({ context }) => ({ counter: context.counter }),
          onDone: ({ output }) => ({
            target: 'checking',
            context: { counter: output },
          }),
        },
      },
      checking: {
        always: ({ context }) =>
          context.counter < context.countUpTo
            ? { target: 'counter' }
            : { target: 'result' },
      },
      result: {
        type: 'final',
        output: ({ context }) => ({ counter: context.counter }),
      },
    },
  });

  const actor = createActor(machine, { input: { countUpTo: 3 } });
  actor.start();
  await toPromise(actor);

  assert.deepEqual(actor.getSnapshot().output, { counter: 3 });
}

if (import.meta.url === new URL(process.argv[1]!, 'file:').href) {
  await runBurrCounterExample();
}
