import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { createAgentMachine } from '../index.js';
import {
  createNextSessionRouteHandlers,
  dynamic,
  maxDuration,
  runtime,
} from './index.js';

describe('next adapter', () => {
  test('adapts generic session handlers to App Router route params', async () => {
    const machine = createAgentMachine({
      id: 'next-adapter-test',
      schemas: {
        input: z.object({
          request: z.string(),
        }),
        events: {
          approve: z.object({}),
        },
      },
      context: (input) => ({
        request: input.request,
        approved: false,
      }),
      initial: 'review',
      states: {
        review: {
          on: {
            approve: {
              target: 'done',
              context: {
                approved: true,
              },
            },
          },
        },
        done: {
          type: 'final',
          output: ({ context }) => ({
            request: context.request,
            approved: context.approved,
          }),
        },
      },
    });
    const routes = createNextSessionRouteHandlers(machine);

    expect(runtime).toBe('nodejs');
    expect(dynamic).toBe('force-dynamic');
    expect(maxDuration).toBe(30);

    const startResponse = await routes.sessions.POST(
      new Request('https://agent.test/api/sessions', {
        method: 'POST',
        body: JSON.stringify({ request: 'Ship it.' }),
      })
    );
    const startBody = await startResponse.json() as {
      sessionId: string;
    };

    const sendResponse = await routes.events.POST(
      new Request(`https://agent.test/api/sessions/${startBody.sessionId}/events`, {
        method: 'POST',
        body: JSON.stringify({ type: 'approve' }),
      }),
      {
        params: Promise.resolve({
          sessionId: startBody.sessionId,
        }),
      }
    );
    const sendBody = await sendResponse.json() as {
      snapshot: { value: string; output: unknown };
    };

    expect(sendBody.snapshot).toEqual(
      expect.objectContaining({
        value: 'done',
        output: {
          request: 'Ship it.',
          approved: true,
        },
      })
    );
  });
});
