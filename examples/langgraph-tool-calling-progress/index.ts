import assert from 'node:assert/strict';
import { z } from 'zod';
import { createActor, createAsyncLogic, toPromise, waitFor } from 'xstate';
import { setupAgent } from '../../src/index.js';

export async function runLangGraphToolCallingProgressExample() {
  const emitted: string[] = [];
  const agent = setupAgent({
    context: z.object({
      city: z.string(),
      forecast: z.string().nullable(),
    }),
    input: z.object({ city: z.string() }),
    output: z.object({ forecast: z.string() }),
    actors: {
      getWeather: createAsyncLogic<string, { city: string }>({
        run: async ({ input }) => {
          emitted.push(`call:${input.city}`);
          emitted.push(`progress:${input.city}:1`);
          emitted.push(`progress:${input.city}:2`);
          return `Sunny in ${input.city}`;
        },
      }),
    },
  });

  const machine = agent.createMachine({
    id: 'raw-xstate-tool-calling',
    context: ({ input }) => ({ city: input.city, forecast: null }),
    initial: 'checkingWeather',
    states: {
      checkingWeather: {
        invoke: {
          src: 'getWeather',
          input: ({ context }) => ({ city: context.city }),
          onDone: ({ output }) => ({
            target: 'done',
            context: { forecast: output },
          }),
        },
      },
      done: {
        type: 'final',
        output: ({ context }) => ({ forecast: context.forecast ?? '' }),
      },
    },
  });

  const actor = createActor(machine, { input: { city: 'Boston' } });
  actor.start();
  await toPromise(actor);

  assert.deepEqual(emitted, [
    'call:Boston',
    'progress:Boston:1',
    'progress:Boston:2',
  ]);
  assert.deepEqual(actor.getSnapshot().output, { forecast: 'Sunny in Boston' });
}

if (import.meta.url === new URL(process.argv[1]!, 'file:').href) {
  await runLangGraphToolCallingProgressExample();
}
