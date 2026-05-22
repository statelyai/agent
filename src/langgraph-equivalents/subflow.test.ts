import { describe, expect, test, vi } from 'vitest';
import { execute, invoke, stream } from '../local/index.js';
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
        schemas: { output: z.object({ bullets: z.array(z.string()) }) },
        invoke: async ({ context }) => ({
          bullets: [`fact about ${context.topic}`, `another fact about ${context.topic}`],
        }),
        onDone: ({ output }) => ({
          target: 'done',
          context: { bullets: output.bullets },
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
        schemas: { output: z.object({ bullets: z.array(z.string()) }) },
        invoke: async ({ context }) => {
          const result = await execute(childMachine, 
            childMachine.getInitialState({ topic: context.topic })
          );

          if (result.status !== 'done') {
            throw new Error('Child machine did not finish');
          }

          return {
            bullets: (result.output as { bullets: string[] }).bullets,
          };
        },
        onDone: ({ output }) => ({
          target: 'writing',
          context: { bullets: output.bullets },
        }),
      },
      writing: {
        schemas: { output: z.object({ draft: z.string() }) },
        invoke: async ({ context }) => ({
          draft: `${context.topic}: ${context.bullets.join('; ')}`,
        }),
        onDone: ({ output }) => ({
          target: 'done',
          context: { draft: output.draft },
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

  const result = await execute(parentMachine, 
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
