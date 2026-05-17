import { z } from 'zod';
import { createSessionHttpController } from '../src/http/index.js';
import {
  createAgentMachine,
  createMemoryRunStore,
  type RunStore,
} from '../src/index.js';

const streamingInputSchema = z.object({
  streamId: z.string(),
  text: z.string(),
});

const streamingOutputSchema = z.object({
  text: z.string(),
});

const textPartSchema = z.object({
  delta: z.string(),
});

export interface StreamingSessionHttpController {
  handle(request: Request): Promise<Response>;
  advance(streamId: string): void;
  dropActiveSession(sessionId: string): void;
}

export function createStreamingSessionHttpController(options: {
  store?: RunStore;
} = {}): StreamingSessionHttpController {
  const store = options.store ?? createMemoryRunStore();
  const streamer = createDurableChunkStreamer();
  const machine = createAgentMachine({
    id: 'http-streaming-session-example',
    schemas: {
      input: streamingInputSchema,
      output: streamingOutputSchema,
      emitted: {
        textPart: textPartSchema,
      },
    },
    context: (input) => ({
      streamId: input.streamId,
      text: input.text,
      finalText: '',
    }),
    initial: 'writing',
    states: {
      writing: {
        schemas: { output: streamingOutputSchema },
        invoke: async ({ context }, enq) =>
          streamer.streamText(context.streamId, context.text, (delta) => {
            enq.emit({ type: 'textPart', delta });
          }),
        onDone: ({ output }) => ({
          target: 'done',
          context: { finalText: output.text },
        }),
      },
      done: {
        type: 'final',
        output: ({ context }) => ({
          text: context.finalText,
        }),
      },
    },
  });
  const controller = createSessionHttpController(machine, { store });

  return {
    advance(streamId) {
      streamer.advance(streamId);
    },

    dropActiveSession(sessionId) {
      controller.dropActiveSession(sessionId);
    },

    async handle(request) {
      return controller.handle(request);
    },
  };
}

function createDurableChunkStreamer() {
  const cursors = new Map<string, number>();
  const invocations = new Map<string, number>();
  const waiters = new Map<string, Array<() => void>>();

  return {
    advance(streamId: string) {
      const current = waiters.get(streamId) ?? [];
      waiters.set(streamId, []);
      for (const resolve of current) {
        resolve();
      }
    },

    async streamText(
      streamId: string,
      text: string,
      emit: (delta: string) => void
    ) {
      const chunks = splitIntoChunks(text);
      const invocation = (invocations.get(streamId) ?? 0) + 1;
      invocations.set(streamId, invocation);
      let cursor = cursors.get(streamId) ?? 0;

      while (cursor < chunks.length) {
        if (invocation < (invocations.get(streamId) ?? 0)) {
          await new Promise(() => {});
        }

        await new Promise<void>((resolve) => {
          waiters.set(streamId, [...(waiters.get(streamId) ?? []), resolve]);
        });

        if (invocation < (invocations.get(streamId) ?? 0)) {
          await new Promise(() => {});
        }

        emit(chunks[cursor]!);
        cursor += 1;
        cursors.set(streamId, cursor);
      }

      return { text };
    },
  };
}

function splitIntoChunks(text: string): string[] {
  if (text.length <= 3) {
    return [text];
  }

  return [text.slice(0, 3), text.slice(3)];
}
