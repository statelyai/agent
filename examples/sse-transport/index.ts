// SSE transport for runAgent's streaming seams.
//
// runAgent exposes three observational seams — `onChunk` (per streamed text
// chunk), `onTransition` (per machine transition), and the final result. A
// host can forward each to a client over any transport. This example wires
// them to Server-Sent Events (`text/event-stream`): one `data:` frame per
// chunk, an `event: transition` frame per state transition, and a final
// `event: done` frame carrying the machine output.
//
// The same seams work for WebSocket — sketch, not implemented here:
//   const wss = new WebSocketServer({ server });
//   wss.on('connection', (ws) => runMachineStream(machine, {
//     onChunk: (c) => ws.send(JSON.stringify({ type: 'chunk', chunk: c })),
//     onTransition: (s) => ws.send(JSON.stringify({ type: 'transition', value: s.value })),
//   }).then((out) => ws.send(JSON.stringify({ type: 'done', output: out }))));
// (frames become JSON messages instead of `event:`/`data:` lines.)

import { createServer, type Server } from 'node:http';
import { z } from 'zod';
import type { AnyStateMachine } from 'xstate';
import { runAgent, setupAgent } from '../../src/index.js';

/**
 * A minimal streaming machine: one `mode: 'stream'` text request, then done.
 * The streamed text becomes the machine output.
 */
export function createSseMachine(): AnyStateMachine {
  const agent = setupAgent({
    context: z.object({ topic: z.string(), text: z.string().nullable() }),
    input: z.object({ topic: z.string() }),
    output: z.object({ text: z.string() }),
    requests: {
      streamTopic: {
        mode: 'stream',
        schemas: { input: z.object({ topic: z.string() }), output: z.string() },
        model: 'writer',
        prompt: ({ input }) => input.topic,
      },
    },
  });

  return agent.createMachine({
    id: 'sse-streamer',
    context: ({ input }) => ({ topic: input.topic, text: null }),
    initial: 'streaming',
    states: {
      streaming: {
        invoke: {
          src: 'streamTopic',
          input: ({ context }) => ({ topic: context.topic }),
          onDone: ({ output }) => ({ target: 'done', context: { text: output } }),
        },
      },
      done: {
        type: 'final',
        output: ({ context }) => ({ text: context.text ?? '' }),
      },
    },
  }) as AnyStateMachine;
}

/**
 * Mock `streamText` executor: yields a few chunks with small delays (no
 * network model calls). Each chunk goes through runAgent's `onChunk` seam.
 */
async function mockStreamText(
  request: { prompt?: string },
  info?: { onChunk?: (chunk: string) => void }
): Promise<{ output: string }> {
  const chunks = ['Once ', 'upon ', `a topic: ${request.prompt ?? ''}`];
  for (const chunk of chunks) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    info?.onChunk?.(chunk);
  }
  return { output: chunks.join('') };
}

/** Runs the machine, plumbing the streaming seams to the supplied handlers. */
export function runMachineStream(
  machine: AnyStateMachine,
  handlers: {
    onChunk: (chunk: string) => void;
    onTransition: (value: unknown) => void;
  }
) {
  return runAgent(machine, {
    input: { topic: 'agents' },
    streamText: mockStreamText,
    onChunk: (chunk) => handlers.onChunk(chunk),
    onTransition: (snapshot) => handlers.onTransition(snapshot.value),
  });
}

/** Writes one SSE frame (optional `event:` line + `data:` line). */
function writeSseFrame(
  res: import('node:http').ServerResponse,
  data: unknown,
  event?: string
): void {
  if (event) {
    res.write(`event: ${event}\n`);
  }
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

/**
 * An `http.Server` whose single endpoint runs the machine and forwards the
 * streaming seams as Server-Sent Events. Host-owned: the machine knows
 * nothing about SSE.
 */
export function createSseServer(): Server {
  return createServer(async (_req, res) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });

    const machine = createSseMachine();
    const result = await runMachineStream(machine, {
      onChunk: (chunk) => writeSseFrame(res, { chunk }),
      onTransition: (value) => writeSseFrame(res, { value }, 'transition'),
    });

    const output = result.status === 'done' ? result.output : { error: result.status };
    writeSseFrame(res, output, 'done');
    res.end();
  });
}
