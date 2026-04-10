import { expect, test } from 'vitest';
import { z } from 'zod';
import { createAgentMachine } from '../index.js';

test('supports branching-style orchestration with plain async fan-out inside invoke', async () => {
  const machine = createAgentMachine({
    id: 'langgraph-equivalent-branching',
    schemas: {
      input: z.object({ topic: z.string() }),
    },
    context: (input) => ({
      topic: input.topic,
      docs: null as string | null,
      issues: null as string | null,
      code: null as string | null,
      summary: null as string | null,
    }),
    initial: 'analyzing',
    states: {
      analyzing: {
        resultSchema: z.object({
          docs: z.string(),
          issues: z.string(),
          code: z.string(),
        }),
        invoke: async ({ context }) => {
          const [docs, issues, code] = await Promise.all([
            Promise.resolve(`docs about ${context.topic}`),
            Promise.resolve(`issues about ${context.topic}`),
            Promise.resolve(`code about ${context.topic}`),
          ]);

          return { docs, issues, code };
        },
        onDone: ({ result }) => ({
          target: 'summarizing',
          context: result,
        }),
      },
      summarizing: {
        // paramsschema could help here, the summary has lots of string | null
        resultSchema: z.object({ summary: z.string() }),
        invoke: async ({ context }) => ({
          summary: [context.docs, context.issues, context.code].join(' | '),
        }),
        onDone: ({ result }) => ({
          target: 'done',
          context: { summary: result.summary },
        }),
      },
      done: {
        type: 'final',
        output: ({ context }) => ({
          docs: context.docs,
          issues: context.issues,
          code: context.code,
          summary: context.summary,
        }),
      },
    },
  });

  const result = await machine.execute(
    machine.getInitialState({ topic: 'agents' })
  );

  expect(result.status).toBe('done');
  if (result.status === 'done') {
    expect(result.output).toEqual({
      docs: 'docs about agents',
      issues: 'issues about agents',
      code: 'code about agents',
      summary: 'docs about agents | issues about agents | code about agents',
    });
  }
});
