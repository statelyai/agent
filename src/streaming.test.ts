import { expect, test } from 'vitest';
import { z } from 'zod';
import {
  createAgentMachine,
  createMemoryRunStore,
  startSession,
} from './index.js';

test('emitted parts flow through the run-level API', async () => {
  const machine = createAgentMachine({
    id: 'streaming-parts',
    schemas: {
      emitted: {
        textPart: z.object({ delta: z.string() }),
      },
    },
    context: () => ({ finalText: '' }),
    initial: 'writing',
    states: {
      writing: {
        resultSchema: z.object({ text: z.string() }),
        invoke: async (_args, enq) => {
          enq.emit({ type: 'textPart', delta: 'hel' });
          enq.emit({ type: 'textPart', delta: 'lo' });

          return { text: 'hello' };
        },
        onDone: ({ result }) => ({
          target: 'done',
          context: { finalText: result.text },
        }),
      },
      done: {
        type: 'final',
        output: ({ context }) => ({ text: context.finalText }),
      },
    },
  });

  const store = createMemoryRunStore();
  const run = await startSession(machine, { store });
  const parts: Array<{ type: string; delta: string }> = [];
  const states: string[] = [];
  const events: string[] = [];

  const offPart = run.on('textPart', (part) => {
    parts.push(part as { type: string; delta: string });
  });
  const offState = run.on('state', (snapshot) => {
    states.push((snapshot as { value: string }).value);
  });
  const offEvent = run.on('machine.event', (event) => {
    events.push((event as { type: string }).type);
  });

  expect(parts).toEqual([
    { type: 'textPart', delta: 'hel' },
    { type: 'textPart', delta: 'lo' },
  ]);
  expect(states).toContain('writing');
  expect(states[states.length - 1]).toBe('done');
  expect(events).toContain('xstate.done.invoke.writing');
  expect(run.getSnapshot().output).toEqual({ text: 'hello' });

  offPart();
  offState();
  offEvent();
});

test('invalid emitted parts are rejected', async () => {
  const machine = createAgentMachine({
    id: 'streaming-invalid-parts',
    schemas: {
      emitted: {
        textPart: z.object({ delta: z.string().min(1) }),
      },
    },
    context: () => ({ count: 0 }),
    initial: 'writing',
    states: {
      writing: {
        invoke: async (_args, enq) => {
          enq.emit({ type: 'textPart', delta: '' });
          return { ok: true };
        },
      },
    },
  });

  const run = await startSession(machine, {
    store: createMemoryRunStore(),
  });

  expect(run.getSnapshot()).toEqual(
    expect.objectContaining({
      value: 'writing',
      status: 'error',
      error: expect.objectContaining({
        message: expect.stringContaining("Invalid emitted part 'textPart'"),
      }),
    })
  );
});
