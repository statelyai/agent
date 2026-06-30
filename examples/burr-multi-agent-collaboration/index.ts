import assert from 'node:assert/strict';
import { z } from 'zod';
import { createActor, createAsyncLogic, toPromise, waitFor } from 'xstate';
import { setupAgent } from '../../src/index.js';

export async function runBurrMultiAgentCollaborationExample() {
  const routeSchema = z.object({
    route: z.enum(['researcher', 'chartGenerator']),
  });
  const agent = setupAgent({
    context: z.object({
      request: z.string(),
      route: z.enum(['researcher', 'chartGenerator']).nullable(),
      result: z.string().nullable(),
    }),
    input: z.object({ request: z.string() }),
    output: z.object({ result: z.string() }),
    actors: {
      researcher: createAsyncLogic<string, { request: string }>({
        run: async ({ input }) => `research:${input.request}`,
      }),
      chartGenerator: createAsyncLogic<string, { request: string }>({
        run: async ({ input }) => `chart:${input.request}`,
      }),
    },
    requests: {
      routeWork: {
        schemas: {
          input: z.object({ request: z.string() }),
          output: routeSchema,
        },
        model: 'supervisor',
        prompt: ({ input }) => input.request,
      },
    },
  });

  const machine = agent.createMachine({
    id: 'burr-multi-agent-collaboration-xstate',
    context: ({ input }) => ({
      request: input.request,
      route: null,
      result: null,
    }),
    initial: 'supervising',
    states: {
      supervising: {
        invoke: {
          src: 'routeWork',
          input: ({ context }) => ({ request: context.request }),
          onDone: ({ output }) => ({
            target: 'dispatch',
            context: { route: output.route },
          }),
        },
      },
      dispatch: {
        always: ({ context }) =>
          context.route === 'chartGenerator'
            ? { target: 'charting' }
            : { target: 'researching' },
      },
      researching: {
        invoke: {
          src: 'researcher',
          input: ({ context }) => ({ request: context.request }),
          onDone: ({ output }) => ({
            target: 'done',
            context: { result: output },
          }),
        },
      },
      charting: {
        invoke: {
          src: 'chartGenerator',
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

  const actor = createActor(
    machine.provide({
      actorSources: {
        routeWork: agent.requests.routeWork.withExecutor(async () => ({
          route: 'chartGenerator',
        })),
      },
    }),
    { input: { request: 'plot revenue' } },
  );
  actor.start();
  await toPromise(actor);

  assert.deepEqual(actor.getSnapshot().output, {
    result: 'chart:plot revenue',
  });
}

if (import.meta.url === new URL(process.argv[1]!, 'file:').href) {
  await runBurrMultiAgentCollaborationExample();
}
