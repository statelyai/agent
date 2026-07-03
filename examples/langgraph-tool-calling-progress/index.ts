import assert from 'node:assert/strict';
import { z } from 'zod';
import { createAsyncLogic } from 'xstate';
import { runAgent, setupAgent } from '../../src/index.js';

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

  // Progress is emitted host-side, mid-tool-call — runAgent's onTransition
  // observes machine state changes (typed, from the snapshot), while the
  // tool call itself pushes fine-grained progress into the host's own
  // side channel as it runs. Neither needs a custom event/streaming layer.
  const transitions: string[] = [];
  const result = await runAgent(machine, {
    input: { city: 'Boston' },
    generateText: async () => ({}),
    onTransition: (snapshot) => {
      transitions.push(String(snapshot.value));
    },
  });

  assert.equal(result.status, 'done');
  assert.deepEqual(emitted, [
    'call:Boston',
    'progress:Boston:1',
    'progress:Boston:2',
  ]);
  assert.deepEqual(transitions, ['checkingWeather', 'done']);
  assert.deepEqual(result.status === 'done' ? result.output : undefined, {
    forecast: 'Sunny in Boston',
  });
}

if (import.meta.url === new URL(process.argv[1]!, 'file:').href) {
  await runLangGraphToolCallingProgressExample();
}
