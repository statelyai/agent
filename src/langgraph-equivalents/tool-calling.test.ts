import { expect, test } from 'vitest';
import { z } from 'zod';
import {
  createAgentMachine,
  createMemoryRunStore,
  startSession,
} from '../index.js';

function once<T = unknown>(
  run: { on(type: string, handler: (event: unknown) => void): () => void },
  type: string
) {
  return new Promise<T>((resolve) => {
    let off = () => {};
    off = run.on(type, (event) => {
      off();
      resolve(event as T);
    });
  });
}

test('supports tool-call style invokes with live tool events and final output', async () => {
  const machine = createAgentMachine({
    id: 'langgraph-equivalent-tool-calling',
    schemas: {
      emitted: {
        toolCall: z.object({
          toolName: z.string(),
          input: z.object({ city: z.string() }),
        }),
        toolResult: z.object({
          toolName: z.string(),
          output: z.object({ forecast: z.string() }),
        }),
      },
      input: z.object({ city: z.string() }),
    },
    context: (input) => ({
      city: input.city,
      forecast: null as string | null,
    }),
    initial: 'checkingWeather',
    states: {
      checkingWeather: {
        resultSchema: z.object({ forecast: z.string() }),
        invoke: async ({ context }, enq) => {
          enq.emit({
            type: 'toolCall',
            toolName: 'getWeather',
            input: { city: context.city },
          });

          const output = { forecast: `Sunny in ${context.city}` };
          enq.emit({
            type: 'toolResult',
            toolName: 'getWeather',
            output,
          });

          return output;
        },
        onDone: ({ result }) => ({
          target: 'done',
          context: { forecast: result.forecast },
        }),
      },
      done: {
        type: 'final',
        output: ({ context }) => ({ forecast: context.forecast }),
      },
    },
  });

  const run = await startSession(machine, {
    store: createMemoryRunStore(),
    input: { city: 'Boston' },
  });
  const events: string[] = [];

  run.on('toolCall', (event) => {
    events.push(`call:${(event as { toolName: string }).toolName}`);
  });
  run.on('toolResult', (event) => {
    events.push(`result:${(event as { toolName: string }).toolName}`);
  });

  await once(run, 'done');

  expect(events).toEqual(['call:getWeather', 'result:getWeather']);
  expect(run.getSnapshot()).toEqual(
    expect.objectContaining({
      value: 'done',
      status: 'done',
      output: { forecast: 'Sunny in Boston' },
    })
  );
});
