import { describe, expect, test, vi } from 'vitest';
import { execute, invoke, stream } from '../local/index.js';
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
        schemas: { output: z.object({
          docs: z.string(),
          issues: z.string(),
          code: z.string(),
        }) },
        invoke: async ({ context }) => {
          const [docs, issues, code] = await Promise.all([
            Promise.resolve(`docs about ${context.topic}`),
            Promise.resolve(`issues about ${context.topic}`),
            Promise.resolve(`code about ${context.topic}`),
          ]);

          return { docs, issues, code };
        },
        onDone: ({ output }) => ({
          target: 'summarizing',
          context: output,
        }),
      },
      summarizing: {
        // paramsschema could help here, the summary has lots of string | null
        schemas: { output: z.object({ summary: z.string() }) },
        invoke: async ({ context }) => ({
          summary: [context.docs, context.issues, context.code].join(' | '),
        }),
        onDone: ({ output }) => ({
          target: 'done',
          context: { summary: output.summary },
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

  const result = await execute(machine, 
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
