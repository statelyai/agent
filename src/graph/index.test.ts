import { expect, test } from 'vitest';
import { setup } from 'xstate';
import { toGraph, toMermaid } from './index.js';

test('exports finite states and transition edges from XState setup machines', () => {
  const agent = setup({
    types: {} as {
      context: { count: number };
      input: { count: number };
      events: { type: 'NEXT' };
    },
  });
  const machine = agent.createMachine({
    id: 'graph-export',
    context: ({ input }) => ({ count: input.count }),
    initial: 'idle',
    states: {
      idle: {
        on: {
          NEXT: { target: 'done' },
        },
      },
      done: { type: 'final' },
    },
  });

  expect(toGraph(machine)).toMatchObject({
    id: 'graph-export',
    initialNodeId: 'idle',
    nodes: [
      { id: 'idle', label: 'idle', data: { type: 'state' } },
      { id: 'done', label: 'done', data: { type: 'final' } },
    ],
    edges: [
      {
        id: 'idle:NEXT:done:0',
        sourceId: 'idle',
        targetId: 'done',
        label: 'NEXT',
        data: { source: 'event', event: 'NEXT' },
      },
    ],
  });
});

test('exports Mermaid from XState setup machines', () => {
  const agent = setup({
    types: {} as { context: {} },
  });
  const machine = agent.createMachine({
    id: 'mermaid-export',
    context: {},
    initial: 'a',
    states: {
      a: { always: { target: 'b' } },
      b: { type: 'final' },
    },
  });

  expect(toMermaid(machine)).toContain('stateDiagram-v2');
  expect(toMermaid(machine)).toContain('a --> b');
});
