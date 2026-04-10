import { z } from 'zod';
import { createAgentMachine } from '../src/index.js';
import {
  closePrompt,
  formatResult,
  generateExampleObject,
  isMain,
  prompt,
} from './_run.js';

const jokeSchema = z.object({
  joke: z.string(),
});

const ratingSchema = z.object({
  rating: z.number().min(1).max(10),
  explanation: z.string(),
});

export function createJokeExample(
  options: {
    tellJoke?: (topic: string) => Promise<z.infer<typeof jokeSchema>>;
    rateJoke?: (
      topic: string,
      joke: string
    ) => Promise<z.infer<typeof ratingSchema>>;
  } = {}
) {
  const tellJoke =
    options.tellJoke ??
    ((topic: string) =>
      generateExampleObject({
        schema: jokeSchema,
        system: 'You write short, clean jokes.',
        prompt: `Write one short joke about ${topic}.`,
      }));
  const rateJoke =
    options.rateJoke ??
    ((topic: string, joke: string) =>
      generateExampleObject({
        schema: ratingSchema,
        system: 'You are a joke critic. Be fair and concise.',
        prompt: [
          `Topic: ${topic}`,
          `Joke: ${joke}`,
          '',
          'Rate the joke from 1 to 10 and explain briefly.',
        ].join('\n'),
      }));

  return createAgentMachine({
    id: 'joke-example',
    schemas: {
      input: z.object({ topic: z.string() }),
    },
    context: (input) => ({
      topic: input.topic,
      joke: null as string | null,
      rating: null as number | null,
      explanation: null as string | null,
      accepted: false,
    }),
    initial: 'telling',
    states: {
      telling: {
        resultSchema: jokeSchema,
        invoke: async ({ context }) => tellJoke(context.topic),
        onDone: ({ result }) => ({
          target: 'rating',
          context: { joke: result.joke },
        }),
      },
      rating: {
        resultSchema: ratingSchema,
        invoke: async ({ context }) => rateJoke(context.topic, context.joke ?? ''),
        onDone: ({ result }) => ({
          target: 'done',
          context: {
            rating: result.rating,
            explanation: result.explanation,
            accepted: result.rating >= 7,
          },
        }),
      },
      done: {
        type: 'final',
        output: ({ context }) => ({
          topic: context.topic,
          joke: context.joke,
          rating: context.rating,
          explanation: context.explanation,
          accepted: context.accepted,
        }),
      },
    },
  });
}

async function main() {
  try {
    const topic = await prompt('Joke topic');
    const machine = createJokeExample();
    console.log(formatResult(await machine.execute(machine.getInitialState({ topic }))));
  } finally {
    closePrompt();
  }
}

if (isMain(import.meta.url)) {
  void main();
}
