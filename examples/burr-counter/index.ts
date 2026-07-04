/**
 * Burr Counter — hello-world-counter's explicit state + guarded loop.
 *
 * Burr's `hello-world-counter` example loops an `@action` node, re-entering
 * it until a condition halts the application. Here that's a plain XState
 * actor (`increment`, no model call) invoked from a state that loops back to
 * itself via a guarded `always` transition — same shape, hosted with
 * `runAgent` instead of manual `createActor`/`toPromise` choreography.
 */
import assert from 'node:assert/strict';
import { z } from 'zod';
import { createAsyncLogic } from 'xstate';
import { runAgent, setupAgent } from '../../src/index.js';

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
      type: 'choice',
      choice: ({ context }) =>
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

  const result = await runAgent(machine, {
    input: { countUpTo: 3 },
    generateText: async () => ({}),
  });

  if (result.status !== 'done') {
    throw new Error(`Counter did not complete: ${result.status}`);
  }
  assert.deepEqual(result.output, { counter: 3 });
}

if (import.meta.url === new URL(process.argv[1]!, 'file:').href) {
  await runBurrCounterExample();
}
