import { expect, test } from 'vitest';
import { z } from 'zod';
import { createAgentMachine } from '../index.js';

test('supports subflow composition by executing a child machine inside a parent invoke', async () => {
  const childMachine = createAgentMachine({
    id: 'child-research',
    schemas: {
      input: z.object({ topic: z.string() }),
    },
    context: (input) => ({
      topic: input.topic,
      bullets: [] as string[],
    }),
    initial: 'researching',
    states: {
      researching: {
        resultSchema: z.object({ bullets: z.array(z.string()) }),
        invoke: async ({ context }) => ({
          bullets: [`fact about ${context.topic}`, `another fact about ${context.topic}`],
        }),
        onDone: ({ result }) => ({
          target: 'done',
          context: { bullets: result.bullets },
        }),
      },
      done: {
        type: 'final',
        output: ({ context }) => ({ bullets: context.bullets }),
      },
    },
  });

  const parentMachine = createAgentMachine({
    id: 'parent-writer',
    schemas: {
      input: z.object({ topic: z.string() }),
    },
    context: (input) => ({
      topic: input.topic,
      bullets: [] as string[],
      draft: null as string | null,
    }),
    initial: 'researching',
    states: {
      researching: {
        resultSchema: z.object({ bullets: z.array(z.string()) }),
        invoke: async ({ context }) => {
          const result = await childMachine.execute(
            childMachine.getInitialState({ topic: context.topic })
          );

          if (result.status !== 'done') {
            throw new Error('Child machine did not finish');
          }

          return {
            bullets: (result.output as { bullets: string[] }).bullets,
          };
        },
        onDone: ({ result }) => ({
          target: 'writing',
          context: { bullets: result.bullets },
        }),
      },
      writing: {
        resultSchema: z.object({ draft: z.string() }),
        invoke: async ({ context }) => ({
          draft: `${context.topic}: ${context.bullets.join('; ')}`,
        }),
        onDone: ({ result }) => ({
          target: 'done',
          context: { draft: result.draft },
        }),
      },
      done: {
        type: 'final',
        output: ({ context }) => ({
          bullets: context.bullets,
          draft: context.draft,
        }),
      },
    },
  });

  const result = await parentMachine.execute(
    parentMachine.getInitialState({ topic: 'state machines' })
  );

  expect(result.status).toBe('done');
  if (result.status === 'done') {
    expect(result.output).toEqual({
      bullets: [
        'fact about state machines',
        'another fact about state machines',
      ],
      draft:
        'state machines: fact about state machines; another fact about state machines',
    });
  }
});
