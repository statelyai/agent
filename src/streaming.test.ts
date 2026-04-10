import { expect, test } from 'vitest';
import { z } from 'zod';
import {
  createAgentMachine,
  createMemoryRunStore,
  startSession,
} from './index.js';

function once<T = unknown>(
  run: { on(type: string, handler: (event: unknown) => void): () => void },
  type: string
) {
  return new Promise<T>((resolve) => {
    let off = () => {};
    off = run.on(type, (event) => {
      off();
      resolve(event as T);
    });
  });
}

test('returns a live run before initial invoke output and emits ephemeral parts', async () => {
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
  const allParts: Array<{ type: string; delta: string }> = [];
  const states: string[] = [];
  const events: string[] = [];
  const done = once<{ output: { text: string } }>(run, 'done');

  const offPart = run.on('textPart', (part) => {
    parts.push(part as { type: string; delta: string });
  });
  const offAnyPart = run.on('part', (part) => {
    allParts.push(part as { type: string; delta: string });
  });
  const offState = run.on('state', (snapshot) => {
    states.push((snapshot as { value: string }).value);
  });
  const offEvent = run.on('machine.event', (event) => {
    events.push((event as { type: string }).type);
  });

  expect(run.getSnapshot()).toEqual(
    expect.objectContaining({
      value: 'writing',
      status: 'active',
    })
  );

  await done;

  expect(parts).toEqual([
    { type: 'textPart', delta: 'hel' },
    { type: 'textPart', delta: 'lo' },
  ]);
  expect(allParts).toEqual([
    { type: 'textPart', delta: 'hel' },
    { type: 'textPart', delta: 'lo' },
  ]);
  expect(states.length).toBeGreaterThan(0);
  expect(states.every((state) => state === 'done')).toBe(true);
  expect(events).toContain('xstate.done.invoke.writing');
  expect(run.getSnapshot().output).toEqual({ text: 'hello' });

  offPart();
  offAnyPart();
  offState();
  offEvent();
});

test('does not replay prior events to late subscribers', async () => {
  const machine = createAgentMachine({
    id: 'late-streaming-subscriber',
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

  const run = await startSession(machine, {
    store: createMemoryRunStore(),
  });
  await once(run, 'done');

  const lateParts: Array<{ type: string; delta: string }> = [];
  const replayedStates: string[] = [];
  const replayedEvents: string[] = [];

  run.on('textPart', (part) => {
    lateParts.push(part as { type: string; delta: string });
  });
  run.on('state', (snapshot) => {
    replayedStates.push((snapshot as { value: string }).value);
  });
  run.on('machine.event', (event) => {
    replayedEvents.push((event as { type: string }).type);
  });
  run.on('done', () => {
    replayedEvents.push('done');
  });

  expect(lateParts).toEqual([]);
  expect(replayedStates).toEqual([]);
  expect(replayedEvents).toEqual([]);
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
  await once(run, 'error');

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

test('transition handlers can emit live effects without journaling them', async () => {
  const machine = createAgentMachine({
    id: 'transition-handler-emits',
    schemas: {
      emitted: {
        textPart: z.object({ delta: z.string() }),
      },
      events: {
        send: z.object({}),
      },
    },
    context: () => ({ sent: false }),
    initial: 'ready',
    states: {
      ready: {
        on: {
          send: ({ context }, enq) => {
            enq.emit({ type: 'textPart', delta: 'sending' });

            return {
              target: 'done',
              context: { sent: !context.sent },
            };
          },
        },
      },
      done: {
        type: 'final',
        output: ({ context }) => context,
      },
    },
  });

  const store = createMemoryRunStore();
  const run = await startSession(machine, { store });
  const parts: string[] = [];

  run.on('textPart', (part) => {
    parts.push((part as { delta: string }).delta);
  });

  await run.send({ type: 'send' });

  expect(parts).toEqual(['sending']);
  expect(run.getSnapshot()).toEqual(
    expect.objectContaining({
      value: 'done',
      status: 'done',
      context: { sent: true },
    })
  );

  const journal = await store.loadEvents(run.sessionId);
  expect(journal.map((event) => event.type)).toEqual([
    'xstate.init',
    'send',
  ]);
});
