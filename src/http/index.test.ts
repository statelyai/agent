import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { createAgentMachine } from '../index.js';
import { createSessionHttpController } from './index.js';

function createSseReader(response: Response) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  return {
    async next(): Promise<{ event: string; data: unknown }> {
      while (true) {
        const match = buffer.match(/^event: ([^\n]+)\ndata: ([^\n]+)\n\n/);
        if (match) {
          buffer = buffer.slice(match[0].length);
          return {
            event: match[1]!,
            data: JSON.parse(match[2]!),
          };
        }

        const chunk = await reader.read();
        if (chunk.done) {
          throw new Error('SSE stream closed before the next event was available.');
        }

        buffer += decoder.decode(chunk.value, { stream: true });
      }
    },

    async cancel() {
      await reader.cancel();
    },
  };
}

describe('http adapter', () => {
  test('starts sessions, sends events, reads snapshots, and streams emitted events', async () => {
    const machine = createAgentMachine({
      id: 'http-adapter-test',
      schemas: {
        input: z.object({
          text: z.string(),
        }),
        events: {
          begin: z.object({}),
        },
        emitted: {
          textPart: z.object({
            delta: z.string(),
          }),
        },
      },
      context: (input) => ({
        text: input.text,
        finalText: '',
      }),
      initial: 'waiting',
      states: {
        waiting: {
          on: {
            begin: {
              target: 'writing',
            },
          },
        },
        writing: {
          schemas: { output: z.object({
            text: z.string(),
          }) },
          invoke: async ({ context }, enq) => {
            enq.emit({ type: 'textPart', delta: context.text });
            return { text: context.text };
          },
          onDone: ({ output }) => ({
            target: 'done',
            context: {
              finalText: output.text,
            },
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
    const controller = createSessionHttpController(machine);

    const startResponse = await controller.handle(
      new Request('https://agent.test/sessions', {
        method: 'POST',
        body: JSON.stringify({ text: 'hello' }),
      })
    );
    const startBody = await startResponse.json() as {
      sessionId: string;
      snapshot: { value: string; status: string };
    };

    expect(startBody.snapshot).toEqual(
      expect.objectContaining({
        value: 'waiting',
        status: 'active',
      })
    );

    const streamResponse = await controller.handle(
      new Request(`https://agent.test/sessions/${startBody.sessionId}/stream`)
    );
    const reader = createSseReader(streamResponse);

    const sendPromise = controller.handle(
      new Request(`https://agent.test/sessions/${startBody.sessionId}/events`, {
        method: 'POST',
        body: JSON.stringify({ type: 'begin' }),
      })
    );

    await expect(reader.next()).resolves.toEqual({
      event: 'textPart',
      data: {
        type: 'textPart',
        delta: 'hello',
      },
    });
    await expect(reader.next()).resolves.toEqual({
      event: 'done',
      data: {
        text: 'hello',
      },
    });

    const sendResponse = await sendPromise;
    expect(sendResponse.status).toBe(200);

    const statusResponse = await controller.handle(
      new Request(`https://agent.test/sessions/${startBody.sessionId}`)
    );
    const statusBody = await statusResponse.json() as {
      snapshot: { value: string; status: string; output: unknown };
    };

    expect(statusBody.snapshot).toEqual(
      expect.objectContaining({
        value: 'done',
        status: 'done',
        output: {
          text: 'hello',
        },
      })
    );
  });
});
