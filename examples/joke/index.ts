import { z } from 'zod';
import { openai } from '@ai-sdk/openai';
import { type LanguageModel } from 'ai';
import { createAgentSchemas, createTextLogic, setupAgent } from '../../src/index.js';

const jokeSchema = z.object({
  joke: z.string(),
});

const schemas = createAgentSchemas({
  context: z.object({
    topic: z.string(),
    joke: z.string().nullable(),
    feedback: z.string().nullable(),
  }),
  input: z.object({ topic: z.string() }),
  output: jokeSchema,
});

// Annotated with LanguageModel so the exported const has a portable, nameable
// type (TS2742); model-ref keys are inferred from this map regardless.
export const models: Record<'jokeWriter', LanguageModel> = {
  jokeWriter: openai('gpt-5.4-mini'),
} as const;

export const tellJoke = createTextLogic({
  mode: 'stream',
  schemas: {
    input: z.object({ topic: z.string() }),
    output: z.string(),
  },
  model: 'jokeWriter',
  system: 'You tell short, punchy jokes.',
  prompt: ({ input }) => `Tell a joke about ${input.topic}.`,
});

export const jokeActors = {
  tellJoke,
};

const jokeAgent = setupAgent({
  schemas,
  models,
  actorSources: jokeActors,
});

export const jokeSchemas = schemas;

export const jokeMachine = jokeAgent.createMachine({
  id: 'joke-streamer',
  context: ({ input }) => ({ topic: input.topic, joke: null, feedback: null }),
  output: ({ context }) => ({ joke: context.joke ?? '' }),
  initial: 'streaming',
  states: {
    streaming: {
      invoke: {
        id: 'joke',
        src: 'tellJoke',
        input: ({ context }) => ({ topic: context.topic }),
        onDone: ({ output }) => ({
          target: 'reviewing',
          context: { joke: output },
        }),
      },
    },
    reviewing: {
      invoke: {
        id: 'jokeFeedback',
        src: 'agent.userInput',
        input: ({ context }) => ({
          prompt: `How was this joke? ${context.joke ?? ''}`,
          schema: z.object({ feedback: z.string() }),
        }),
        onDone: ({ event }) => ({
          target: 'checkingFeedback',
          // `agent.userInput`'s output is `unknown`: xstate derives a named
          // invoke's onDone output from the *registered* actor's output type
          // (`OutputFrom<TActorMap['agent.userInput']>`), which can't depend on
          // this invoke's per-call `input.schema`. So the schema still validates
          // the answer at runtime, but the type needs a cast here.
          context: {
            feedback: (event.output as { feedback?: string }).feedback ?? '',
          },
        }),
      },
    },
    checkingFeedback: {
      type: 'choice',
      choice: ({ context }) =>
        /\b(done|stop|enough|no more|finished|quit|ok(?:ay)?\b.*\bdone)\b/i
          .test(context.feedback ?? '')
          ? { target: 'done' }
          : { target: 'streaming' },
    },
    done: { type: 'final' },
  },
});
