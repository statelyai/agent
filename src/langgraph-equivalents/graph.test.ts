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
        resultSchema: z.object({ messages: z.array(z.string()) }),
        invoke: async () => ({ messages: ['from node1'] }),
        onDone: ({ result, context }) => ({
          target: 'node2',
          context: { messages: [...context.messages, ...result.messages] },
        }),
      },
      node2: {
        resultSchema: z.object({ messages: z.array(z.string()) }),
        invoke: async () => ({ messages: ['from node2'] }),
        onDone: ({ result, context }) => ({
          target: 'node3',
          context: { messages: [...context.messages, ...result.messages] },
        }),
      },
      node3: {
        resultSchema: z.object({ messages: z.array(z.string()) }),
        invoke: async () => ({ messages: ['from node3'] }),
        onDone: ({ result, context }) => ({
          target: 'done',
          context: { messages: [...context.messages, ...result.messages] },
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
        resultSchema: z.object({
          route: z.enum(['billing', 'general']),
        }),
        invoke: async ({ context }) => {
          const route = context.request.toLowerCase().includes('refund')
            ? 'billing'
            : 'general';

          return { route } as const;
        },
        onDone: ({ result }) => ({
          target: result.route,
          context: { route: result.route },
        }),
      },
      billing: {
        resultSchema: z.object({ handledBy: z.literal('billing') }),
        invoke: async () => ({ handledBy: 'billing' as const }), // why do we need to cast to const here?
        onDone: ({ result }) => ({
          target: 'done',
          context: { handledBy: result.handledBy },
        }),
      },
      general: {
        resultSchema: z.object({ handledBy: z.literal('general') }),
        invoke: async () => ({ handledBy: 'general' as const }),
        onDone: ({ result }) => ({
          target: 'done',
          context: { handledBy: result.handledBy },
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
