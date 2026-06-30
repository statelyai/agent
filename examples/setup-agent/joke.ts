import { z } from 'zod';
import { setup } from 'xstate';
import { createAgentSchemas, createTextLogic } from '../../src/index.js';

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

export const jokeActors = {
  tellJoke,
};

const jokeAgent = setup({
  schemas,
  actorSources: jokeActors,
});

export const jokeSchemas = schemas;

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
        onDone: ({ output }) => ({
          target: 'done',
          context: { joke: output },
        }),
      },
    },
    done: { type: 'final' },
  },
});
