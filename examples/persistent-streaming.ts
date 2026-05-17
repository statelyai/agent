import { z } from 'zod';
import {
  createAgentMachine,
  createMemoryRunStore,
  restoreSession,
  startSession,
} from '../src/index.js';

const textSchema = z.object({
  text: z.string(),
});

const textPartSchema = z.object({
  delta: z.string(),
});

export function createPersistentStreamingExample(
  writeText: (emitPart: (delta: string) => void) => Promise<z.infer<typeof textSchema>> = (() => {
    const chunks = ['hel', 'lo'];
    let cursor = 0;
    let attempts = 0;

    return async (emitPart) => {
      attempts += 1;

      if (attempts === 1) {
        emitPart(chunks[cursor++]!);
        await new Promise(() => {});
      }

      while (cursor < chunks.length) {
        emitPart(chunks[cursor++]!);
      }

      return { text: chunks.join('') };
    };
  })()
) {
  return createAgentMachine({
    id: 'persistent-streaming-example',
    schemas: {
      output: textSchema,
      emitted: {
        textPart: textPartSchema,
      },
    },
    context: () => ({
      finalText: '',
    }),
    initial: 'writing',
    states: {
      writing: {
        schemas: { output: textSchema },
        invoke: async (_args, enq) =>
          writeText((delta) => {
            enq.emit({ type: 'textPart', delta });
          }),
        onDone: ({ output }) => ({
          target: 'done',
          context: { finalText: output.text },
        }),
      },
      done: {
        type: 'final',
        output: ({ context }) => ({ text: context.finalText }),
      },
    },
  });
}

export async function runPersistentStreamingExample(
  writeText?: (emitPart: (delta: string) => void) => Promise<z.infer<typeof textSchema>>
) {
  const machine = createPersistentStreamingExample(writeText);
  const store = createMemoryRunStore();
  const initialRun = await startSession(machine, { store });
  const initialParts: string[] = [];

  initialRun.on('textPart', (event) => {
    initialParts.push(event.delta);
  });

  await waitFor(
    () => initialParts.length >= 1 && initialRun.getSnapshot().status === 'active'
  );

  const restoredRun = await restoreSession(machine, {
    sessionId: initialRun.sessionId,
    store,
  });
  const restoredParts: string[] = [];

  restoredRun.on('textPart', (event) => {
    restoredParts.push(event.delta);
  });

  await once(restoredRun.onDone.bind(restoredRun));

  return {
    sessionId: initialRun.sessionId,
    initialParts,
    restoredParts,
    initialSnapshot: initialRun.getSnapshot(),
    restoredSnapshot: restoredRun.getSnapshot(),
    journal: await store.loadEvents(initialRun.sessionId),
  };
}

function once<T = unknown>(
  subscribe: (handler: (event: T) => void) => () => void
) {
  return new Promise<T>((resolve) => {
    let off = () => {};
    off = subscribe((event) => {
      off();
      resolve(event);
    });
  });
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1000
) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    if (predicate()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  if (!predicate()) {
    throw new Error('Condition did not become true before timeout.');
  }
}
