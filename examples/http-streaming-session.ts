import { z } from 'zod';
import {
  createAgentMachine,
  createMemoryRunStore,
  restoreSession,
  startSession,
  type AgentRun,
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

type StreamingRun = AgentRun<
  { streamId: string; text: string; finalText: string },
  string,
  {},
  { text: string },
  { textPart: typeof textPartSchema }
>;

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
        resultSchema: streamingOutputSchema,
        invoke: async ({ context }, enq) =>
          streamer.streamText(context.streamId, context.text, (delta) => {
            enq.emit({ type: 'textPart', delta });
          }),
        onDone: ({ result }) => ({
          target: 'done',
          context: { finalText: result.text },
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
  const activeRuns = new Map<string, StreamingRun>();

  function trackRun(sessionId: string, run: StreamingRun) {
    activeRuns.set(sessionId, run);
    run.onDone(() => {
      activeRuns.delete(sessionId);
    });
    run.onError(() => {
      activeRuns.delete(sessionId);
    });
    return run;
  }

  async function getRun(sessionId: string): Promise<StreamingRun> {
    const existing = activeRuns.get(sessionId);
    if (existing) {
      return existing;
    }

    const restored = await restoreSession(machine, {
      sessionId,
      store,
    }) as StreamingRun;

    return trackRun(sessionId, restored);
  }

  return {
    advance(streamId) {
      streamer.advance(streamId);
    },

    dropActiveSession(sessionId) {
      activeRuns.delete(sessionId);
    },

    async handle(request) {
      const url = new URL(request.url);
      const match = url.pathname.match(/^\/sessions\/([^/]+)(?:\/stream)?$/);
      const sessionId = match?.[1];
      const isStreamRoute = url.pathname.endsWith('/stream');

      if (request.method === 'POST' && url.pathname === '/sessions') {
        const body = await request.json() as z.infer<typeof streamingInputSchema>;
        const run = await startSession(machine, {
          store,
          input: body,
        }) as StreamingRun;
        trackRun(run.sessionId, run);

        return Response.json({
          sessionId: run.sessionId,
          snapshot: run.getSnapshot(),
        });
      }

      if (request.method === 'GET' && sessionId && !isStreamRoute) {
        const run = await getRun(sessionId);
        return Response.json({
          sessionId,
          snapshot: run.getSnapshot(),
        });
      }

      if (request.method === 'GET' && sessionId && isStreamRoute) {
        const run = await getRun(sessionId);
        let cleanup = () => {};

        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const encoder = new TextEncoder();
            const write = (event: string, data: unknown) => {
              controller.enqueue(
                encoder.encode(
                  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
                )
              );
            };

            if (run.getSnapshot().status === 'done') {
              write('done', run.getSnapshot().output);
              controller.close();
              return;
            }

            if (run.getSnapshot().status === 'error') {
              write('error', { error: String(run.getSnapshot().error) });
              controller.close();
              return;
            }

            const offPart = run.on('textPart', (event) => {
              write('textPart', event);
            });
            const offDone = run.onDone((event) => {
              write('done', event.output);
              cleanup();
              controller.close();
            });
            const offError = run.onError((event) => {
              write('error', { error: String(event.error) });
              cleanup();
              controller.close();
            });

            cleanup = () => {
              offPart();
              offDone();
              offError();
            };
          },
          cancel() {
            // Subscribers are ephemeral transport clients, not run ownership.
            // Closing the stream should detach listeners but leave the run alive.
            cleanup();
          },
        });

        return new Response(stream, {
          headers: {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
          },
        });
      }

      return new Response('Not found', { status: 404 });
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
