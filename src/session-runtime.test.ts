import { expect, test, vi } from 'vitest';
import { z } from 'zod';
import {
  createAgentMachine,
  createMemoryRunStore,
  startSession,
} from './index.js';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });

  return { promise, resolve };
}

test('startSession creates a session, persists xstate.init, and returns before start effects run', async () => {
  const machine = createAgentMachine({
    id: 'session-runtime',
    context: () => ({ count: 0 }),
    initial: 'idle',
    states: {
      idle: {
        on: {
          increment: {
            target: 'done',
            context: { count: 1 },
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
  const snapshot = run.getSnapshot();
  const journal = await store.loadEvents(run.sessionId);
  const persisted = await store.loadLatestSnapshot(run.sessionId);

  expect(run.sessionId).toBe(snapshot.sessionId);
  expect(snapshot).toEqual(
    expect.objectContaining({
      sessionId: run.sessionId,
      value: 'idle',
      status: 'active',
      context: { count: 0 },
      input: {},
    })
  );
  await vi.waitFor(() => {
    expect(run.getSnapshot()).toEqual(
      expect.objectContaining({
        value: 'idle',
        status: 'pending',
      })
    );
  });
  expect(journal).toEqual([
    expect.objectContaining({
      sequence: 1,
      type: 'xstate.init',
      at: expect.any(Number),
    }),
  ]);
  expect(persisted).toEqual(
    expect.objectContaining({
      sessionId: run.sessionId,
      afterSequence: 1,
      snapshot,
    })
  );
});

test('serializes concurrent sends so each event applies from the latest snapshot', async () => {
  const gates = [deferred(), deferred()];
  let invocations = 0;
  const machine = createAgentMachine({
    id: 'serialized-send',
    schemas: {
      events: {
        increment: z.object({ amount: z.number() }),
      },
    },
    context: () => ({ count: 0 }),
    initial: 'ready',
    states: {
      ready: {
        on: {
          increment: ({ event, context }) => ({
            target: 'working',
            context: { count: context.count + event.amount },
          }),
        },
      },
      working: {
        resultSchema: z.object({ count: z.number() }),
        invoke: async ({ context }) => {
          const gate = gates[invocations++]!;
          await gate.promise;
          return { count: context.count };
        },
        onDone: ({ result }) => ({
          target: 'ready',
          context: { count: result.count },
        }),
      },
    },
  });

  const run = await startSession(machine, { store: createMemoryRunStore() });
  await vi.waitFor(() => {
    expect(run.getSnapshot()).toEqual(
      expect.objectContaining({
        value: 'ready',
        status: 'pending',
      })
    );
  });

  const first = run.send({ type: 'increment', amount: 1 });
  const second = run.send({ type: 'increment', amount: 10 });

  await vi.waitFor(() => {
    expect(invocations).toBe(1);
  });

  gates[0]!.resolve();
  await first;
  await vi.waitFor(() => {
    expect(invocations).toBe(2);
  });

  gates[1]!.resolve();
  await second;

  expect(run.getSnapshot()).toEqual(
    expect.objectContaining({
      value: 'ready',
      status: 'pending',
      context: { count: 11 },
    })
  );
});

test('journals always transitions and persists messages', async () => {
  const machine = createAgentMachine({
    id: 'always-session',
    context: () => ({ ready: false }),
    messages: () => [{ role: 'user', content: 'start' }],
    initial: 'checking',
    states: {
      checking: {
        always: ({ messages }) => ({
          target: 'done',
          context: { ready: true },
          messages: messages.concat({ role: 'assistant', content: 'done' }),
        }),
      },
      done: {
        type: 'final',
        output: ({ context, messages }) => ({ ...context, messages }),
      },
    },
  });
  const store = createMemoryRunStore();
  const run = await startSession(machine, { store });

  await vi.waitFor(() => {
    expect(run.getSnapshot()).toEqual(
      expect.objectContaining({
        value: 'done',
        status: 'done',
        context: { ready: true },
        messages: [
          { role: 'user', content: 'start' },
          { role: 'assistant', content: 'done' },
        ],
      })
    );
  });

  await expect(store.loadEvents(run.sessionId)).resolves.toEqual([
    expect.objectContaining({ sequence: 1, type: 'xstate.init' }),
    expect.objectContaining({ sequence: 2, type: 'xstate.always.checking' }),
  ]);
});

test('rejects reserved internal events from run.send', async () => {
  const machine = createAgentMachine({
    id: 'reserved-events',
    context: () => ({ count: 0 }),
    initial: 'ready',
    states: {
      ready: {
        on: {
          go: { target: 'done' },
        },
      },
      done: { type: 'final' },
    },
  });

  const run = await startSession(machine, { store: createMemoryRunStore() });
  await vi.waitFor(() => {
    expect(run.getSnapshot()).toEqual(
      expect.objectContaining({
        value: 'ready',
        status: 'pending',
      })
    );
  });

  await expect(run.send({ type: 'xstate.init' })).rejects.toThrow(
    /reserved internal event/i
  );
  await expect(
    run.send({ type: 'xstate.done.invoke.worker' })
  ).rejects.toThrow(/reserved internal event/i);
  await expect(
    run.send({ type: 'xstate.error.invoke.worker' })
  ).rejects.toThrow(/reserved internal event/i);
  await expect(
    run.send({ type: 'xstate.always.ready' })
  ).rejects.toThrow(/reserved internal event/i);
});
