import assert from 'node:assert/strict';
import { z } from 'zod';
import { createAsyncLogic } from 'xstate';
import { runAgent, setupAgent } from '../../src/index.js';
const models = {
  "planner": "planner",
} as const;


export async function runLangGraphPlanAndExecuteExample() {
  const planSchema = z.object({
    steps: z.array(z.string()),
  });
  const agent = setupAgent({
    models,
    context: z.object({
      request: z.string(),
      steps: z.array(z.string()),
      results: z.array(z.string()),
    }),
    input: z.object({ request: z.string() }),
    output: z.object({ results: z.array(z.string()) }),
    actors: {
      runStep: createAsyncLogic<string, { step: string }>({
        run: async ({ input }) => `done:${input.step}`,
      }),
    },
    requests: {
      planTask: {
        schemas: {
          input: z.object({ request: z.string() }),
          output: planSchema,
        },
        model: 'planner',
        prompt: ({ input }) => input.request,
      },
    },
  });

  const machine = agent.createMachine({
    id: 'raw-xstate-plan-and-execute',
    context: ({ input }) => ({
      request: input.request,
      steps: [],
      results: [],
    }),
    initial: 'planning',
    states: {
      planning: {
        invoke: {
          src: 'planTask',
          input: ({ context }) => ({ request: context.request }),
          onDone: ({ output }) => ({
            target: 'running',
            context: { steps: output.steps },
          }),
        },
      },
      running: {
        invoke: {
          src: 'runStep',
          input: ({ context }) => ({ step: context.steps[0] ?? '' }),
          onDone: ({ context, output }) => ({
            target: 'checking',
            context: {
              steps: context.steps.slice(1),
              results: [...context.results, output],
            },
          }),
        },
      },
      checking: {
        always: ({ context }) =>
          context.steps.length > 0 ? { target: 'running' } : { target: 'done' },
      },
      done: {
        type: 'final',
        output: ({ context }) => ({ results: context.results }),
      },
    },
  });

  const result = await runAgent(machine, {
    input: { request: 'make a brief' },
    generateText: async () => ({ steps: ['research', 'write'] }),
  });

  assert.equal(result.status, 'done');
  assert.deepEqual(result.status === 'done' ? result.output : undefined, {
    results: ['done:research', 'done:write'],
  });
}

if (import.meta.url === new URL(process.argv[1]!, 'file:').href) {
  await runLangGraphPlanAndExecuteExample();
}
