/**
 * Burr Multi-Agent Collaboration — supervisor routing to typed workers.
 *
 * Burr's `multi-agent-collaboration` example dispatches work between a
 * researcher and a chart-generator agent. Here a `routeWork` request picks
 * the worker, and a guarded `always` transition dispatches to whichever
 * typed host actor (`researcher`/`chartGenerator`) was chosen — hosted with
 * `runAgent` instead of manual `createActor`/`toPromise` choreography.
 */
import assert from 'node:assert/strict';
import { z } from 'zod';
import { createAsyncLogic } from 'xstate';
import { runAgent, setupAgent } from '../../src/index.js';

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

  const result = await runAgent(machine, {
    input: { request: 'plot revenue' },
    generateText: async () => ({ object: { route: 'chartGenerator' } }),
  });

  if (result.status !== 'done') {
    throw new Error(`Multi-agent collaboration example did not complete: ${result.status}`);
  }
  assert.deepEqual(result.output, {
    result: 'chart:plot revenue',
  });
}

if (import.meta.url === new URL(process.argv[1]!, 'file:').href) {
  await runBurrMultiAgentCollaborationExample();
}
