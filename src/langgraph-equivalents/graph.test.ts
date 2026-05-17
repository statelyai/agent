import { expect, test } from 'vitest';
import { z } from 'zod';
import { createAgentMachine } from '../index.js';

test('supports multi-step workflow accumulation like a sequential state graph', async () => {
  const machine = createAgentMachine({
    id: 'langgraph-equivalent-sequence',
    context: () => ({ messages: [] as string[] }),
    initial: 'node1',
    states: {
      node1: {
        schemas: { output: z.object({ messages: z.array(z.string()) }) },
        invoke: async () => ({ messages: ['from node1'] }),
        onDone: ({ output, context }) => ({
          target: 'node2',
          context: { messages: [...context.messages, ...output.messages] },
        }),
      },
      node2: {
        schemas: { output: z.object({ messages: z.array(z.string()) }) },
        invoke: async () => ({ messages: ['from node2'] }),
        onDone: ({ output, context }) => ({
          target: 'node3',
          context: { messages: [...context.messages, ...output.messages] },
        }),
      },
      node3: {
        schemas: { output: z.object({ messages: z.array(z.string()) }) },
        invoke: async () => ({ messages: ['from node3'] }),
        onDone: ({ output, context }) => ({
          target: 'done',
          context: { messages: [...context.messages, ...output.messages] },
        }),
      },
      done: {
        type: 'final',
        output: ({ context }) => context,
      },
    },
  });

  const result = await machine.execute(machine.getInitialState());

  expect(result.status).toBe('done');
  if (result.status === 'done') {
    expect(result.output).toEqual({
      messages: ['from node1', 'from node2', 'from node3'],
    });
  }
});

test('supports conditional routing with explicit machine transitions', async () => {
  const machine = createAgentMachine({
    id: 'langgraph-equivalent-routing',
    schemas: {
      input: z.object({ request: z.string() }),
    },
    context: (input) => ({
      request: input.request,
      route: null as string | null,
      handledBy: null as string | null,
    }),
    initial: 'routeRequest',
    states: {
      routeRequest: {
        schemas: { output: z.object({
          route: z.enum(['billing', 'general']),
        }) },
        invoke: async ({ context }) => {
          const route = context.request.toLowerCase().includes('refund')
            ? 'billing'
            : 'general';

          return { route } as const;
        },
        onDone: ({ output }) => ({
          target: output.route,
          context: { route: output.route },
        }),
      },
      billing: {
        schemas: { output: z.object({ handledBy: z.literal('billing') }) },
        invoke: async () => ({ handledBy: 'billing' as const }), // why do we need to cast to const here?
        onDone: ({ output }) => ({
          target: 'done',
          context: { handledBy: output.handledBy },
        }),
      },
      general: {
        schemas: { output: z.object({ handledBy: z.literal('general') }) },
        invoke: async () => ({ handledBy: 'general' as const }),
        onDone: ({ output }) => ({
          target: 'done',
          context: { handledBy: output.handledBy },
        }),
      },
      done: {
        type: 'final',
        output: ({ context }) => ({
          route: context.route,
          handledBy: context.handledBy,
        }),
      },
    },
  });

  const result = await machine.execute(
    machine.getInitialState({ request: 'I need a refund for my invoice.' })
  );

  expect(result.status).toBe('done');
  if (result.status === 'done') {
    expect(result.output).toEqual({
      route: 'billing',
      handledBy: 'billing',
    });
  }
});
