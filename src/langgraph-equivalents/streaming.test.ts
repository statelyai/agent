import { expect, test } from 'vitest';
import { z } from 'zod';
import {
  createAgentMachine,
  createMemoryRunStore,
  startSession,
} from '../index.js';

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

test('streams live invoke output while preserving durable state history', async () => {
  const machine = createAgentMachine({
    id: 'langgraph-equivalent-streaming',
    schemas: {
      emitted: {
        textPart: z.object({ delta: z.string() }),
      },
    },
    context: () => ({ text: '' }),
    initial: 'write',
    states: {
      write: {
        resultSchema: z.object({ text: z.string() }),
        invoke: async (_args, enq) => {
          enq.emit({ type: 'textPart', delta: 'hello' });
          enq.emit({ type: 'textPart', delta: ' world' });
          return { text: 'hello world' };
        },
        onDone: ({ result }) => ({
          target: 'done',
          context: { text: result.text },
        }),
      },
      done: {
        type: 'final',
        output: ({ context }) => ({ text: context.text }),
      },
    },
  });

  const run = await startSession(machine, {
    store: createMemoryRunStore(),
  });
  const liveParts: string[] = [];

  run.on('textPart', (part) => {
    liveParts.push((part as { delta: string }).delta);
  });

  await once(run, 'done');

  expect(liveParts).toEqual(['hello', ' world']);
  expect(run.getSnapshot()).toEqual(
    expect.objectContaining({
      value: 'done',
      status: 'done',
      output: { text: 'hello world' },
    })
  );
});
