import assert from 'node:assert/strict';
import { z } from 'zod';
import { createAsyncLogic } from 'xstate';
import { runAgent, setupAgent } from '../../src/index.js';
const models = {
  "router": "router",
} as const;


export async function runLangGraphSupervisorHandoffExample() {
  const agent = setupAgent({
    models,
    context: z.object({
      request: z.string(),
      route: z.enum(['research', 'write']).nullable(),
      result: z.string().nullable(),
    }),
    input: z.object({ request: z.string() }),
    output: z.object({ result: z.string() }),
    actors: {
      research: createAsyncLogic<string, { request: string }>({
        run: async ({ input }) => `research:${input.request}`,
      }),
      write: createAsyncLogic<string, { request: string }>({
        run: async ({ input }) => `write:${input.request}`,
      }),
    },
    requests: {
      routeRequest: {
        schemas: {
          input: z.object({ request: z.string() }),
          output: z.object({ route: z.enum(['research', 'write']) }),
        },
        model: 'router',
        prompt: ({ input }) => input.request,
      },
    },
  });

  const machine = agent.createMachine({
    id: 'raw-xstate-supervisor',
    context: ({ input }) => ({
      request: input.request,
      route: null,
      result: null,
    }),
    initial: 'routing',
    states: {
      routing: {
        invoke: {
          src: 'routeRequest',
          input: ({ context }) => ({ request: context.request }),
          onDone: ({ output }) => ({
            target: 'dispatch',
            context: { route: output.route },
          }),
        },
      },
      dispatch: {
      type: 'choice',
      choice: ({ context }) =>
          context.route === 'research'
            ? { target: 'researching' }
            : { target: 'writing' },
      },
      researching: {
        invoke: {
          src: 'research',
          input: ({ context }) => ({ request: context.request }),
          onDone: ({ output }) => ({
            target: 'done',
            context: { result: output },
          }),
        },
      },
      writing: {
        invoke: {
          src: 'write',
          input: ({ context }) => ({ request: context.request }),
          onDone: ({ output }) => ({
            target: 'done',
            context: { result: output },
          }),
        },
      },
      done: {
        type: 'final',
        output: ({ context }) => ({ result: context.result ?? '' }),
      },
    },
  });

  const result = await runAgent(machine, {
    input: { request: 'compare frameworks' },
    generateText: async () => ({ route: 'research' }),
  });

  assert.equal(result.status, 'done');
  assert.deepEqual(result.status === 'done' ? result.output : undefined, {
    result: 'research:compare frameworks',
  });
}

if (import.meta.url === new URL(process.argv[1]!, 'file:').href) {
  await runLangGraphSupervisorHandoffExample();
}
