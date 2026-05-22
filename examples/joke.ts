import { z } from 'zod';
import { execute } from '../src/local/index.js';
import { createAgentMachine, type AgentAdapter } from '../src/index.js';
import {
  closePrompt,
  createOpenAiGenerationAdapter,
  formatResult,
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
  adapter: AgentAdapter = createOpenAiGenerationAdapter()
) {
  return createAgentMachine({
    id: 'joke-example',
    adapter,
    schemas: {
      input: z.object({ topic: z.string() }),
      output: z.object({
        topic: z.string(),
        joke: z.string().nullable(),
        rating: z.number().nullable(),
        explanation: z.string().nullable(),
        accepted: z.boolean(),
      }),
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
        schemas: { output: jokeSchema },
        system: 'You write short, clean jokes.',
        prompt: ({ context }) => `Write one short joke about ${context.topic}.`,
        onDone: ({ output }) => ({
          target: 'rating',
          context: { joke: output.joke },
        }),
      },
      rating: {
        schemas: { output: ratingSchema },
        system: 'You are a joke critic. Be fair and concise.',
        prompt: ({ context }) =>
          [
            `Topic: ${context.topic}`,
            `Joke: ${context.joke ?? ''}`,
            '',
            'Rate the joke from 1 to 10 and explain briefly.',
          ].join('\n'),
        onDone: ({ output }) => ({
          target: 'done',
          context: {
            rating: output.rating,
            explanation: output.explanation,
            accepted: output.rating >= 7,
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
    console.log(formatResult(await execute(machine, machine.getInitialState({ topic }))));
  } finally {
    closePrompt();
  }
}

if (isMain(import.meta.url)) {
  void main();
}
