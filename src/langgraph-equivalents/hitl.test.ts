import { describe, expect, test, vi } from 'vitest';
import { execute, invoke, stream } from '../local/index.js';
import { z } from 'zod';
import { createAgentMachine } from '../index.js';

test('supports human-in-the-loop review with explicit pending states and external events', async () => {
  const machine = createAgentMachine({
    id: 'langgraph-equivalent-hitl',
    schemas: {
      input: z.object({ task: z.string() }),
      events: {
        approve: z.object({}),
        revise: z.object({ note: z.string() }),
      },
    },
    context: (input) => ({
      task: input.task,
      notes: [] as string[],
      draft: null as string | null,
    }),
    initial: 'drafting',
    states: {
      drafting: {
        schemas: { output: z.object({ draft: z.string() }) },
        invoke: async ({ context }) => ({
          draft: `Draft for ${context.task}${context.notes.length ? ` (${context.notes.join(', ')})` : ''}`,
        }),
        onDone: ({ output }) => ({
          target: 'review',
          context: { draft: output.draft },
        }),
      },
      review: {
        on: {
          approve: { target: 'done' },
          revise: ({ event, context }) => ({
            target: 'drafting',
            context: { notes: [...context.notes, event.note] },
          }),
        },
      },
      done: {
        type: 'final',
        output: ({ context }) => ({ draft: context.draft }),
      },
    },
  });

  const first = await execute(machine, 
    machine.getInitialState({ task: 'reply to customer' })
  );

  expect(first.status).toBe('pending');
  if (first.status !== 'pending') return;

  expect(first.value).toBe('review');
  expect(first.context.draft).toContain('reply to customer');

  const revised = machine.transition(first.state, {
    type: 'revise',
    note: 'make it shorter',
  });
  const second = await execute(machine, revised);

  expect(second.status).toBe('pending');
  if (second.status !== 'pending') return;

  const approved = machine.transition(second.state, { type: 'approve' });
  const done = await execute(machine, approved);

  expect(done.status).toBe('done');
  if (done.status === 'done') {
    expect(done.output).toEqual({
      draft: 'Draft for reply to customer (make it shorter)',
    });
  }
});
