import { expect, test } from 'vitest';
import { z } from 'zod';
import { createAgentMachine } from '../index.js';
import { analyzeGraph, toGraph, toMermaid } from './index.js';

declare function unknownTransition(): { target: 'done' };

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
        schemas: { input: z.object({
          index: z.number(),
        }), output: z.object({
          ok: z.boolean(),
        }) },
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
          source: 'event',
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
        label: 'submit [!(event.count > 0)]',
        data: {
          event: 'submit',
          source: 'event',
          guard: { type: '!(event.count > 0)' },
        },
      },
      {
        type: 'edge',
        id: 'working:done.invoke.working:2',
        sourceId: 'working',
        targetId: 'done',
        label: 'done.invoke.working',
        data: {
          event: 'done.invoke.working',
          source: 'invoke.done',
        },
      },
    ],
  });
});

test('exports always transitions and message updates', () => {
  const machine = createAgentMachine({
    id: 'always-graph',
    context: () => ({}),
    initial: 'checking',
    states: {
      checking: {
        always: ({ messages }) => ({
          target: 'done',
          messages: messages.concat({ role: 'assistant', content: 'ok' }),
        }),
      },
      done: {
        type: 'final',
      },
    },
  });

  expect(toGraph(machine).edges).toEqual([
    {
      type: 'edge',
      id: 'checking::0',
      sourceId: 'checking',
      targetId: 'done',
      label: 'always',
      data: {
        event: '',
        source: 'always',
        actions: {
          messages: true,
        },
      },
    },
  ]);
});

test('infers switch, early-return, and helper-call transition branches', () => {
  const machine = createAgentMachine({
    id: 'ast-rich-export',
    schemas: {
      events: {
        route: z.object({
          type: z.literal('route'),
          kind: z.enum(['a', 'b', 'c']),
          urgent: z.boolean(),
        }),
      },
    },
    context: () => ({}),
    initial: 'idle',
    states: {
      idle: {
        on: {
          route: ({ event }) => {
            const toA = () => ({ target: 'a' as const });

            if (event.urgent) {
              return toA();
            }

            switch (event.kind) {
              case 'b':
                return { target: 'b' as const };
              case 'c':
                return { target: 'c' as const };
              default:
                return { target: 'fallback' as const };
            }
          },
        },
      },
      a: { type: 'final' },
      b: { type: 'final' },
      c: { type: 'final' },
      fallback: { type: 'final' },
    },
  });

  expect(toGraph(machine).edges).toEqual([
    expect.objectContaining({
      targetId: 'a',
      data: expect.objectContaining({
        guard: { type: 'event.urgent' },
      }),
    }),
    expect.objectContaining({
      targetId: 'b',
      data: expect.objectContaining({
        guard: { type: '(!(event.urgent)) && (event.kind === "b")' },
      }),
    }),
    expect.objectContaining({
      targetId: 'c',
      data: expect.objectContaining({
        guard: { type: '(!(event.urgent)) && (event.kind === "c")' },
      }),
    }),
    expect.objectContaining({
      targetId: 'fallback',
      data: expect.objectContaining({
        guard: {
          type: '(!(event.urgent)) && (!(event.kind === "b") && !(event.kind === "c"))',
        },
      }),
    }),
  ]);
});

test('reports graph warnings for unsupported transition analysis', () => {
  const machine = createAgentMachine({
    id: 'ast-warning-export',
    schemas: {
      events: {
        go: z.object({ type: z.literal('go') }),
      },
    },
    context: () => ({}),
    initial: 'idle',
    states: {
      idle: {
        on: {
          go: () => {
            return unknownTransition();
          },
        },
      },
      done: { type: 'final' },
    },
  });

  expect(analyzeGraph(machine).warnings).toEqual([
    {
      state: 'idle',
      event: 'go',
      message:
        'Unsupported helper call: unknownTransition() is not statically resolvable.',
    },
  ]);
  expect(toGraph(machine).data).toBeUndefined();
});

test('resolves simple helper calls with arguments in guards and targets', () => {
  const machine = createAgentMachine({
    id: 'helper-args-export',
    schemas: {
      events: {
        choose: z.object({
          type: z.literal('choose'),
          kind: z.enum(['approved', 'rejected']),
        }),
      },
    },
    context: () => ({}),
    initial: 'idle',
    states: {
      idle: {
        on: {
          choose: ({ event }) => {
            function goTo(
              target: 'approved' | 'rejected',
              reason: string
            ) {
              return {
                target,
                context: { reason },
              };
            }

            return event.kind === 'approved'
              ? goTo('approved', 'explicit approval path')
              : goTo('rejected', 'explicit rejection path');
          },
        },
      },
      approved: { type: 'final' },
      rejected: { type: 'final' },
    },
  });

  expect(toGraph(machine).edges).toEqual([
    expect.objectContaining({
      targetId: 'approved',
      data: expect.objectContaining({
        guard: { type: 'event.kind === "approved"' },
        actions: { context: true },
      }),
    }),
    expect.objectContaining({
      targetId: 'rejected',
      data: expect.objectContaining({
        guard: { type: '!(event.kind === "approved")' },
        actions: { context: true },
      }),
    }),
  ]);
});

test('resolves one-level helper forwarding with substituted arguments', () => {
  const machine = createAgentMachine({
    id: 'helper-forwarding-export',
    schemas: {
      events: {
        choose: z.object({
          type: z.literal('choose'),
          kind: z.enum(['approved', 'rejected']),
        }),
      },
    },
    context: () => ({}),
    initial: 'idle',
    states: {
      idle: {
        on: {
          choose: ({ event }) => {
            function goTo(
              target: 'approved' | 'rejected',
              reason: string
            ) {
              return {
                target,
                context: { reason },
              };
            }

            function route(kind: 'approved' | 'rejected') {
              return goTo(kind, `routed:${kind}`);
            }

            return event.kind === 'approved'
              ? route('approved')
              : route('rejected');
          },
        },
      },
      approved: { type: 'final' },
      rejected: { type: 'final' },
    },
  });

  expect(toGraph(machine).edges).toEqual([
    expect.objectContaining({
      targetId: 'approved',
      data: expect.objectContaining({
        guard: { type: 'event.kind === "approved"' },
        actions: { context: true },
      }),
    }),
    expect.objectContaining({
      targetId: 'rejected',
      data: expect.objectContaining({
        guard: { type: '!(event.kind === "approved")' },
        actions: { context: true },
      }),
    }),
  ]);
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

  expect(toMermaid(machine)).toBe(`stateDiagram-v2
    [*] --> idle
    idle --> done : finish
    done --> [*]`);
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
