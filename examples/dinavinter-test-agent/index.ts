import assert from 'node:assert/strict';
import { z } from 'zod';
import {
  createActor,
  createAsyncLogic,
  createCallbackLogic,
  initialTransition,
  transition,
  waitFor,
  type EventObject,
} from 'xstate';
import {
  type AgentRequest,
  assistantMessage,
  createAgentSchemas,
  executeAgentRequest,
  getAgentRequests,
  transitionResult,
  type AgentTextRequest,
  type AgentTools,
} from '../../src/index.js';
import { setupAgent } from '../../src/index.js';

export async function runDinavinterTestAgentExample() {
  const calls: unknown[] = [];
  const schemas = createAgentSchemas({
    context: z.object({
      request: z.string(),
      threadId: z.string().nullable(),
      messageId: z.string().nullable(),
      chunks: z.array(z.string()),
      messages: z.array(z.object({ role: z.string(), content: z.string() })),
    }),
    input: z.object({ request: z.string() }),
    output: z.object({
      threadId: z.string(),
      text: z.string(),
    }),
    events: {
      TEXT_DELTA: z.object({ text: z.string() }),
      IMAGE_URL: z.object({ url: z.string() }),
      STREAM_DONE: z.object({}),
    },
  });

  const agent = setupAgent({
    schemas,
    actors: {
      createThread: createAsyncLogic<string, { request: string }>({
        run: async ({ input }) => {
          calls.push({ actor: 'createThread', request: input.request });
          return 'thread_123';
        },
      }),
      sendMessage: createAsyncLogic<string, { threadId: string; message: string }>({
        run: async ({ input }) => {
          calls.push({ actor: 'sendMessage', input });
          return 'message_123';
        },
      }),
      streamThread: createCallbackLogic<EventObject, { threadId: string }>(
        ({ input, sendBack }) => {
          calls.push({ actor: 'streamThread', input });
          queueMicrotask(() => {
            sendBack({ type: 'TEXT_DELTA', text: 'using ' });
            sendBack({ type: 'TEXT_DELTA', text: 'XState' });
            sendBack({
              type: 'IMAGE_URL',
              url: 'https://example.com/test.png',
            });
            sendBack({ type: 'STREAM_DONE' });
          });
        },
      ),
    },
  });

  const machine = agent.createMachine({
    id: 'dinavinter-test-agent',
    context: ({ input }) => ({
      request: input.request,
      threadId: null,
      messageId: null,
      chunks: [],
      messages: [],
    }),
    initial: 'creatingThread',
    states: {
      creatingThread: {
        invoke: {
          id: 'createThread',
          src: 'createThread',
          input: ({ context }: { context: { request: string } }) => ({
            request: context.request,
          }),
          onDone: ({ output }) => ({
            target: 'sendingMessage',
            context: { threadId: output },
          }),
        },
      },
      sendingMessage: {
        invoke: {
          id: 'sendMessage',
          src: 'sendMessage',
          input: ({
            context,
          }: {
            context: { threadId: string | null; request: string };
          }) => ({
            threadId: context.threadId!,
            message: context.request,
          }),
          onDone: ({ output }) => ({
            target: 'streaming',
            context: { messageId: output },
          }),
        },
      },
      streaming: {
        invoke: {
          id: 'streamThread',
          src: 'streamThread',
          input: ({ context }: { context: { threadId: string | null } }) => ({
            threadId: context.threadId!,
          }),
        },
        on: {
          TEXT_DELTA: ({ context, event }) => ({
            context: {
              chunks: [
                ...context.chunks,
                (event as unknown as { text: string }).text,
              ],
            },
          }),
          IMAGE_URL: ({ context, event }) => ({
            context: {
              messages: [
                ...context.messages,
                assistantMessage((event as unknown as { url: string }).url) as {
                  role: string;
                  content: string;
                },
              ],
            },
          }),
          STREAM_DONE: { target: 'done' },
        },
      },
      done: {
        type: 'final',
        output: ({ context }) => ({
          threadId: context.threadId ?? '',
          text: context.chunks.join(''),
        }),
      },
    },
  });

  const actor = createActor(machine, {
    input: { request: 'Generate an API test.' },
  });
  actor.start();
  await waitFor(actor, (snapshot) => snapshot.status === 'done');

  assert.deepEqual(actor.getSnapshot().output, {
    threadId: 'thread_123',
    text: 'using XState',
  });
  assert.deepEqual(actor.getSnapshot().context.messages, [
    { role: 'assistant', content: 'https://example.com/test.png' },
  ]);
  assert.deepEqual(calls, [
    { actor: 'createThread', request: 'Generate an API test.' },
    {
      actor: 'sendMessage',
      input: {
        threadId: 'thread_123',
        message: 'Generate an API test.',
      },
    },
    { actor: 'streamThread', input: { threadId: 'thread_123' } },
  ]);
}

if (import.meta.url === new URL(process.argv[1]!, 'file:').href) {
  await runDinavinterTestAgentExample();
}
