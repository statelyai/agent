import { z } from 'zod';
import {
  createAgentMachine,
  createMemoryRunStore,
  startSession,
} from '../src/index.js';
import {
  closePrompt,
  generateExampleObject,
  isMain,
  prompt,
} from './_run.js';

const forecastSchema = z.object({
  forecast: z.string(),
});

export function createToolCallingExample(
  getWeather: (city: string) => Promise<z.infer<typeof forecastSchema>> = async (
    city
  ) =>
    generateExampleObject({
      schema: forecastSchema,
      system: 'You generate plausible demo weather forecasts.',
      prompt: `Return a short weather forecast for ${city}.`,
    })
) {
  return createAgentMachine({
    id: 'tool-calling-example',
    schemas: {
      input: z.object({ city: z.string() }),
      output: z.object({ forecast: z.string().nullable() }),
      emitted: {
        toolCall: z.object({
          toolName: z.string(),
          input: z.object({ city: z.string() }),
        }),
        toolResult: z.object({
          toolName: z.string(),
          output: forecastSchema,
        }),
      },
    },
    context: (input) => ({
      city: input.city,
      forecast: null as string | null,
    }),
    initial: 'checkingWeather',
    states: {
      checkingWeather: {
        resultSchema: forecastSchema,
        invoke: async ({ context }, enq) => {
          enq.emit({
            type: 'toolCall',
            toolName: 'getWeather',
            input: { city: context.city },
          });

          const output = await getWeather(context.city);

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
}

async function main() {
  try {
    const city = await prompt('City');
    const machine = createToolCallingExample();
    const run = await startSession(machine, {
      store: createMemoryRunStore(),
      input: { city },
    });

    run.on('toolCall', (event) => {
      console.log(`Calling ${event.toolName}(${event.input.city})`);
    });

    run.on('toolResult', (event) => {
      console.log(`${event.toolName} -> ${event.output.forecast}`);
    });

    await new Promise<void>((resolve, reject) => {
      run.onDone((event) => {
        console.log(event.output);
        resolve();
      });
      run.onError((event) => {
        reject(event.error);
      });
    });
  } finally {
    closePrompt();
  }
}

if (isMain(import.meta.url)) {
  void main();
}
