import { z } from 'zod';
import { assign } from 'xstate';
import { createAgentSchemas, createTextLogic, setupAgent } from '../../src/index.js';

const jokeSchema = z.object({
  joke: z.string(),
});

const schemas = createAgentSchemas({
  context: z.object({
    topic: z.string(),
    joke: z.string().nullable(),
  }),
  input: z.object({ topic: z.string() }),
  output: jokeSchema,
});

export const tellJoke = createTextLogic({
  mode: 'stream',
  schemas: {
    input: z.object({ topic: z.string() }),
    output: z.string(),
  },
  model: 'openai/gpt-5.4-nano',
  system: 'You tell short, punchy jokes.',
  prompt: ({ input }) => `Tell a joke about ${input.topic}.`,
});

const jokeAgent = setupAgent({
  schemas,
  actors: {
    tellJoke,
  },
});

export const jokeSchemas = jokeAgent.schemas;

export const jokeMachine = jokeAgent.createMachine({
  id: 'joke-streamer',
  context: ({ input }) => ({ topic: input.topic, joke: null }),
  output: ({ context }) => ({ joke: context.joke ?? '' }),
  initial: 'streaming',
  states: {
    streaming: {
      invoke: {
        id: 'joke',
        src: 'tellJoke',
        input: ({ context }) => ({ topic: context.topic }),
        onDone: {
          target: 'done',
          actions: assign({ joke: ({ event }) => event.output }),
        },
      },
    },
    done: { type: 'final' },
  },
});
