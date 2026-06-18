import { expect, test } from 'vitest';
import { setup } from 'xstate';
import { analyzeGraph, toGraph, toMermaid } from './index.js';

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

test('warns about invalid graph structure', () => {
  const analysis = analyzeGraph({
    id: 'warning-export',
    config: {
      initial: 'idle',
      states: {
        idle: {
          on: {
            NEXT: { target: 'missing' },
          },
        },
        invoking: {
          invoke: {
            src: 'draftEmail',
            onDone: { target: 'done' },
          },
        },
        orphan: {},
        done: { type: 'final' },
      },
    },
  });

  expect(analysis.warnings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: 'dangling-target',
        state: 'idle',
        event: 'NEXT',
        target: 'missing',
      }),
      expect.objectContaining({
        code: 'missing-invoke-id',
        state: 'invoking',
      }),
      expect.objectContaining({
        code: 'unreachable-state',
        state: 'orphan',
      }),
      expect.objectContaining({
        code: 'dead-end-state',
        state: 'orphan',
      }),
    ])
  );
});

test('warns about missing initial state', () => {
  const analysis = analyzeGraph({
    id: 'missing-initial-export',
    config: {
      initial: 'unknown',
      states: {
        idle: {},
      },
    },
  });

  expect(analysis.warnings).toContainEqual(
    expect.objectContaining({
      code: 'missing-initial',
      state: 'unknown',
    })
  );
});
