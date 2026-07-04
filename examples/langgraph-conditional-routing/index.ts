import assert from 'node:assert/strict';
import { z } from 'zod';
import { runAgent, setupAgent } from '../../src/index.js';
const models = {
  "classifier": "classifier",
} as const;


export async function runLangGraphConditionalRoutingExample() {
  const agent = setupAgent({
    models,
    context: z.object({
      request: z.string(),
      route: z.enum(['answer', 'escalate']).nullable(),
    }),
    input: z.object({ request: z.string() }),
    output: z.object({ route: z.enum(['answer', 'escalate']) }),
    requests: {
      routeRequest: {
        schemas: {
          input: z.object({ request: z.string() }),
          output: z.object({ route: z.enum(['answer', 'escalate']) }),
        },
        model: 'classifier',
        prompt: ({ input }) => input.request,
      },
    },
  });

  const machine = agent.createMachine({
    id: 'raw-xstate-branching',
    context: ({ input }) => ({ request: input.request, route: null }),
    output: ({ context }) => ({ route: context.route ?? 'answer' }),
    initial: 'classifying',
    states: {
      classifying: {
        invoke: {
          src: 'routeRequest',
          input: ({ context }) => ({ request: context.request }),
          onDone: ({ output }) => ({
            target: 'routing',
            context: { route: output.route },
          }),
        },
      },
      routing: {
      type: 'choice',
      choice: ({ context }) =>
          context.route === 'escalate'
            ? { target: 'escalated' }
            : { target: 'answered' },
      },
      answered: {
        type: 'final',
        output: () => ({ route: 'answer' as const }),
      },
      escalated: {
        type: 'final',
        output: () => ({ route: 'escalate' as const }),
      },
    },
  });

  const result = await runAgent(machine, {
    input: { request: 'billing is broken' },
    generateText: async () => ({ route: 'escalate' }),
  });

  assert.equal(result.status, 'done');
  assert.deepEqual(result.status === 'done' ? result.output : undefined, {
    route: 'escalate',
  });
}

if (import.meta.url === new URL(process.argv[1]!, 'file:').href) {
  await runLangGraphConditionalRoutingExample();
}
