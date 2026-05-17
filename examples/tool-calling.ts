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
  waitForRunDone,
} from './_run.js';

const forecastSchema = z.object({
  forecast: z.string(),
});

const toolProgressSchema = z.object({
  toolName: z.string(),
  message: z.string(),
  step: z.number().int().min(1),
});

export function createToolCallingExample(
  getWeather: (
    city: string,
    emitProgress: (event: z.infer<typeof toolProgressSchema>) => void
  ) => Promise<z.infer<typeof forecastSchema>> = async (
    city,
    emitProgress
  ) => {
    emitProgress({
      toolName: 'getWeather',
      message: `Looking up current conditions for ${city}.`,
      step: 1,
    });
    emitProgress({
      toolName: 'getWeather',
      message: `Formatting the forecast for ${city}.`,
      step: 2,
    });

    return generateExampleObject({
      schema: forecastSchema,
      system: 'You generate plausible demo weather forecasts.',
      prompt: `Return a short weather forecast for ${city}.`,
    });
  }
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
        toolProgress: toolProgressSchema,
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
        schemas: { output: forecastSchema },
        invoke: async ({ context }, enq) => {
          enq.emit({
            type: 'toolCall',
            toolName: 'getWeather',
            input: { city: context.city },
          });

          const output = await getWeather(context.city, (progress) => {
            enq.emit({
              type: 'toolProgress',
              ...progress,
            });
          });

          enq.emit({
            type: 'toolResult',
            toolName: 'getWeather',
            output,
          });

          return output;
        },
        onDone: ({ output }) => ({
          target: 'done',
          context: { forecast: output.forecast },
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

    run.on('toolProgress', (event) => {
      console.log(`${event.toolName} [${event.step}] ${event.message}`);
    });

    run.on('toolResult', (event) => {
      console.log(`${event.toolName} -> ${event.output.forecast}`);
    });

    const done = await waitForRunDone(run);
    console.log(done.output);
  } finally {
    closePrompt();
  }
}

if (isMain(import.meta.url)) {
  void main();
}
