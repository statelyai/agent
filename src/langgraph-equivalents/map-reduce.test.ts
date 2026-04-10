import { expect, test } from 'vitest';
import { z } from 'zod';
import { createAgentMachine } from '../index.js';

test('supports map-reduce style orchestration with dynamic work items inside invoke', async () => {
  const machine = createAgentMachine({
    id: 'langgraph-equivalent-map-reduce',
    schemas: {
      input: z.object({ topic: z.string() }),
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
        resultSchema: z.object({ subjects: z.array(z.string()) }),
        invoke: async ({ context }) => ({
          subjects: [`${context.topic} basics`, `${context.topic} advanced`],
        }),
        onDone: ({ result }) => ({
          target: 'mapping',
          context: { subjects: result.subjects },
        }),
      },
      mapping: {
        resultSchema: z.object({ jokes: z.array(z.string()) }),
        invoke: async ({ context }) => {
          const jokes = await Promise.all(
            context.subjects.map(async (subject) => `joke about ${subject}`)
          );

          return { jokes };
        },
        onDone: ({ result }) => ({
          target: 'reducing',
          context: { jokes: result.jokes },
        }),
      },
      reducing: {
        resultSchema: z.object({ bestJoke: z.string() }),
        invoke: async ({ context }) => ({
          bestJoke: context.jokes[0] ?? '',
        }),
        onDone: ({ result }) => ({
          target: 'done',
          context: { bestJoke: result.bestJoke },
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

  const result = await machine.execute(
    machine.getInitialState({ topic: 'state machines' })
  );

  expect(result.status).toBe('done');
  if (result.status === 'done') {
    expect(result.output).toEqual({
      subjects: ['state machines basics', 'state machines advanced'],
      jokes: [
        'joke about state machines basics',
        'joke about state machines advanced',
      ],
      bestJoke: 'joke about state machines basics',
    });
  }
});
