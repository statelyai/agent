import { z } from 'zod';
import { createAgentMachine } from '../src/index.js';
import {
  closePrompt,
  formatResult,
  generateExampleObject,
  generateExampleText,
  isMain,
  prompt,
} from './_run.js';

const subjectsSchema = z.object({
  subjects: z.array(z.string()),
});

const jokesSchema = z.object({
  jokes: z.array(z.string()),
});

const bestJokeSchema = z.object({
  bestJoke: z.string(),
});

export function createMapReduceExample(
  options: {
    planSubjects?: (topic: string) => Promise<z.infer<typeof subjectsSchema>>;
    writeJoke?: (subject: string) => Promise<string>;
    chooseBest?: (jokes: string[]) => Promise<z.infer<typeof bestJokeSchema>>;
  } = {}
) {
  return createAgentMachine({
    id: 'map-reduce-example',
    schemas: {
      input: z.object({ topic: z.string() }),
      output: z.object({
        subjects: z.array(z.string()),
        jokes: z.array(z.string()),
        bestJoke: z.string().nullable(),
      }),
    },
    context: (input) => ({
      topic: input.topic,
      subjects: [] as string[],
      jokes: [] as string[],
      bestJoke: null as string | null,
    }),
    initial: 'planning',
    states: {
      planning: {
        schemas: { output: subjectsSchema },
        invoke: async ({ context }) =>
          (options.planSubjects
            ?? ((topic) =>
              generateExampleObject({
                schema: subjectsSchema,
                system: 'You break a topic into a few concrete subtopics.',
                prompt: `List 2 to 4 specific subtopics worth covering for: ${topic}`,
              })))(context.topic),
        onDone: ({ output }) => ({
          target: 'mapping',
          context: { subjects: output.subjects },
        }),
      },
      mapping: {
        schemas: { output: jokesSchema },
        invoke: async ({ context }) => {
          const jokes = await Promise.all(
            context.subjects.map((subject) =>
              (options.writeJoke
                ?? ((value) =>
                  generateExampleText({
                    system: 'You write one-line jokes.',
                    prompt: `Write one short joke about ${value}.`,
                  })))(subject)
            )
          );

          return { jokes };
        },
        onDone: ({ output }) => ({
          target: 'reducing',
          context: { jokes: output.jokes },
        }),
      },
      reducing: {
        schemas: { output: bestJokeSchema },
        invoke: async ({ context }) =>
          (options.chooseBest
            ?? ((jokes) =>
              generateExampleObject({
                schema: bestJokeSchema,
                system: 'You pick the strongest joke from a list.',
                prompt: ['Choose the best joke from this list:', ...jokes].join('\n'),
              })))(context.jokes),
        onDone: ({ output }) => ({
          target: 'done',
          context: { bestJoke: output.bestJoke },
        }),
      },
      done: {
        type: 'final',
        output: ({ context }) => ({
          subjects: context.subjects,
          jokes: context.jokes,
          bestJoke: context.bestJoke,
        }),
      },
    },
  });
}

async function main() {
  try {
    const topic = await prompt('Topic');
    const machine = createMapReduceExample();
    const result = await machine.execute(machine.getInitialState({ topic }));
    console.log(formatResult(result));
  } finally {
    closePrompt();
  }
}

if (isMain(import.meta.url)) {
  void main();
}
