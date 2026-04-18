import { expect, test } from 'vitest';
import { z } from 'zod';
import { createAgentMachine } from '../index.js';
import { toGraph, toMermaid } from './index.js';

test('exports finite states and transition edges as Stately graph JSON', () => {
  const machine = createAgentMachine({
    id: 'graph-export',
    schemas: {
      events: {
        submit: z.object({
          type: z.literal('submit'),
          count: z.number(),
        }),
      },
    },
    context: () => ({
      total: 0,
    }),
    initial: 'idle',
    states: {
      idle: {
        on: {
          submit: ({ event }) => {
            if (event.count > 0) {
              return {
                target: 'working',
                context: { total: event.count },
                input: { index: event.count },
              };
            }

            return {
              target: 'done',
            };
          },
        },
      },
      working: {
        inputSchema: z.object({
          index: z.number(),
        }),
        resultSchema: z.object({
          ok: z.boolean(),
        }),
        invoke: async () => ({ ok: true }),
        onDone: () => ({
          target: 'done',
        }),
      },
      done: {
        type: 'final',
        output: ({ context }) => context,
      },
    },
  });

  expect(toGraph(machine)).toEqual({
    id: 'graph-export',
    type: 'directed',
    initialNodeId: 'idle',
    data: undefined,
    nodes: [
      { type: 'node', id: 'idle', label: 'idle', data: { type: 'state' } },
      { type: 'node', id: 'working', label: 'working', data: { type: 'state' } },
      { type: 'node', id: 'done', label: 'done', data: { type: 'final' } },
    ],
    edges: [
      {
        type: 'edge',
        id: 'idle:submit:0',
        sourceId: 'idle',
        targetId: 'working',
        label: 'submit [event.count > 0]',
        data: {
          event: 'submit',
          guard: { type: 'event.count > 0' },
          actions: {
            context: true,
            input: true,
          },
        },
      },
      {
        type: 'edge',
        id: 'idle:submit:1',
        sourceId: 'idle',
        targetId: 'done',
        label: 'submit',
        data: {
          event: 'submit',
        },
      },
      {
        type: 'edge',
        id: 'working:done:2',
        sourceId: 'working',
        targetId: 'done',
        label: 'done',
        data: {
          event: 'done',
        },
      },
    ],
  });
});

test('exports a mermaid state diagram from the Stately graph data', () => {
  const machine = createAgentMachine({
    id: 'mermaid-export',
    context: () => ({}),
    initial: 'idle',
    states: {
      idle: {
        on: {
          finish: { target: 'done' },
        },
      },
      done: {
        type: 'final',
      },
    },
  });

  expect(toMermaid(machine)).toContain('idle --> done: finish');
});

test('infers guards from conditional-expression transition branches', () => {
  const machine = createAgentMachine({
    id: 'conditional-export',
    schemas: {
      events: {
        choose: z.object({
          type: z.literal('choose'),
          ok: z.boolean(),
        }),
      },
    },
    context: () => ({}),
    initial: 'idle',
    states: {
      idle: {
        on: {
          choose: ({ event }) =>
            event.ok
              ? { target: 'accepted' }
              : { target: 'rejected' },
        },
      },
      accepted: {
        type: 'final',
      },
      rejected: {
        type: 'final',
      },
    },
  });

  expect(toGraph(machine).edges).toEqual([
    expect.objectContaining({
      sourceId: 'idle',
      targetId: 'accepted',
      data: expect.objectContaining({
        guard: { type: 'event.ok' },
      }),
    }),
    expect.objectContaining({
      sourceId: 'idle',
      targetId: 'rejected',
      data: expect.objectContaining({
        guard: { type: '!(event.ok)' },
      }),
    }),
  ]);
});
