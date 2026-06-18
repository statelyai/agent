import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import {
  assign,
  createActor,
  fromCallback,
  fromPromise,
  initialTransition,
  transition,
  waitFor,
  type EventObject,
} from 'xstate';
import {
  type AgentTask,
  assistantMessage,
  createAgentSchemas,
  setupAgent,
  transitionResult,
  type AgentTextInput,
  type AgentTools,
} from '../index.js';

describe('dinavinter/agents-style XState agents', () => {
  test('test agent keeps Assistant thread APIs as host actors and streams events into state', async () => {
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
        createThread: fromPromise<string, { request: string }>(
          async ({ input }) => {
            calls.push({ actor: 'createThread', request: input.request });
            return 'thread_123';
          }
        ),
        sendMessage: fromPromise<
          string,
          { threadId: string; message: string }
        >(async ({ input }) => {
          calls.push({ actor: 'sendMessage', input });
          return 'message_123';
        }),
        streamThread: fromCallback<EventObject, { threadId: string }>(
          ({ input, sendBack }) => {
            calls.push({ actor: 'streamThread', input });
            queueMicrotask(() => {
              sendBack({ type: 'TEXT_DELTA', text: 'using ' });
              sendBack({ type: 'TEXT_DELTA', text: 'setupAgent' });
              sendBack({ type: 'IMAGE_URL', url: 'https://example.com/test.png' });
              sendBack({ type: 'STREAM_DONE' });
            });
          }
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
            onDone: {
              target: 'sendingMessage',
              actions: assign({
                threadId: ({ event }) => event.output as string,
              }),
            },
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
            onDone: {
              target: 'streaming',
              actions: assign({
                messageId: ({ event }) => event.output as string,
              }),
            },
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
            TEXT_DELTA: {
              actions: assign({
                chunks: ({ context, event }) => [...context.chunks, event.text],
              }),
            },
            IMAGE_URL: {
              actions: assign({
                messages: ({ context, event }) => [
                  ...context.messages,
                  assistantMessage(event.url),
                ],
              }),
            },
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

    expect(actor.getSnapshot().output).toEqual({
      threadId: 'thread_123',
      text: 'using setupAgent',
    });
    expect(actor.getSnapshot().context.messages).toEqual([
      { role: 'assistant', content: 'https://example.com/test.png' },
    ]);
    expect(calls).toEqual([
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
  });

  test('screen-set builder maps streamed object UI drafts to structured task output', async () => {
    const fieldSchema = z.object({
      type: z.enum(['text', 'email', 'password', 'submit']),
      name: z.string(),
      label: z.string(),
    });
    const screenDraftSchema = z.object({
      title: z.string(),
      fields: z.array(fieldSchema),
    });
    const schemas = createAgentSchemas({
      context: z.object({
        request: z.string(),
        draft: screenDraftSchema.nullable(),
      }),
      input: z.object({ request: z.string() }),
      output: screenDraftSchema,
    });
    const agent = setupAgent({ schemas }).withTasks({
      draftScreen: {
        schemas: {
          input: z.object({ request: z.string() }),
          output: screenDraftSchema,
        },
        model: 'openai/gpt-5.4-nano',
        system: 'Create a form screen draft from the user request.',
        prompt: ({ input }) => input.request,
      },
    });
    const machine = agent.createMachine({
      context: ({ input }) => ({ request: input.request, draft: null }),
      initial: 'drafting',
      states: {
        drafting: {
          invoke: {
            id: 'draftScreen',
            src: 'draftScreen',
            input: ({ context }) => ({ request: context.request }),
            onDone: {
              target: 'done',
              actions: assign({ draft: ({ event }) => event.output }),
            },
          },
        },
        done: {
          type: 'final',
          output: ({ context }) =>
            context.draft ?? { title: '', fields: [] },
        },
      },
    });

    let [snapshot, actions] = initialTransition(machine, {
      request: 'Build a signup wizard.',
    });
    const [task] = machine.getTasks(actions, snapshot);

    const output = await machine.execute(task!, {
      generateText: async (request: AgentTextInput & { tools: AgentTools }) => {
        expect(request.outputSchema).toBe(agent.tasks.draftScreen.schemas.output);
        expect(request.prompt).toBe('Build a signup wizard.');
        return {
          output: {
            title: 'Signup',
            fields: [
              { type: 'email', name: 'email', label: 'Email' },
              { type: 'password', name: 'password', label: 'Password' },
              { type: 'submit', name: 'submit', label: 'Create account' },
            ],
          },
        };
      },
    });

    [snapshot, actions] = transitionResult(machine, snapshot, task!, output);

    expect(machine.getTasks(actions, snapshot)).toEqual([]);
    expect(snapshot.output).toEqual({
      title: 'Signup',
      fields: [
        { type: 'email', name: 'email', label: 'Email' },
        { type: 'password', name: 'password', label: 'Password' },
        { type: 'submit', name: 'submit', label: 'Create account' },
      ],
    });
  });

  test('parallel agent runs independent model tasks as explicit XState invokes', async () => {
    const resultSchema = z.object({
      thought: z.string(),
      doodleQuery: z.string(),
    });
    const schemas = createAgentSchemas({
      context: z.object({
        topic: z.string(),
        thought: z.string().nullable(),
        doodleQuery: z.string().nullable(),
      }),
      input: z.object({ topic: z.string() }),
      output: resultSchema,
    });
    const agent = setupAgent({ schemas }).withTasks({
      think: {
        kind: 'stream',
        schemas: {
          input: z.object({ topic: z.string() }),
          output: z.string(),
        },
        model: 'openai/gpt-5.4-nano',
        prompt: ({ input }) => `Think about ${input.topic}.`,
      },
      findDoodle: {
        schemas: {
          input: z.object({ topic: z.string() }),
          output: z.object({ query: z.string() }),
        },
        model: 'openai/gpt-5.4-nano',
        prompt: ({ input }) => `Find a doodle for ${input.topic}.`,
      },
    });
    const machine = agent.createMachine({
      context: ({ input }) => ({
        topic: input.topic,
        thought: null,
        doodleQuery: null,
      }),
      type: 'parallel',
      states: {
        thinking: {
          initial: 'active',
          states: {
            active: {
              invoke: {
                id: 'think',
                src: 'think',
                input: ({ context }) => ({ topic: context.topic }),
                onDone: {
                  target: 'done',
                  actions: assign({ thought: ({ event }) => event.output }),
                },
              },
            },
            done: { type: 'final' },
          },
        },
        doodling: {
          initial: 'active',
          states: {
            active: {
              invoke: {
                id: 'findDoodle',
                src: 'findDoodle',
                input: ({ context }) => ({ topic: context.topic }),
                onDone: {
                  target: 'done',
                  actions: assign({
                    doodleQuery: ({ event }) => event.output.query,
                  }),
                },
              },
            },
            done: { type: 'final' },
          },
        },
      },
      output: ({ context }) => ({
        thought: context.thought ?? '',
        doodleQuery: context.doodleQuery ?? '',
      }),
    });

    let [snapshot, actions] = initialTransition(machine, { topic: 'XState' });
    const tasks = machine.getTasks(actions, snapshot);

    expect(tasks.map((task: AgentTask) => [task.id, task.kind])).toEqual([
      ['think', 'stream'],
      ['findDoodle', 'generate'],
    ]);

    for (const task of tasks) {
      const output = await machine.execute(task, {
        generateText: async () => ({ output: { query: 'statechart sketch' } }),
        streamText: async () => ({ text: 'State machines make flow visible.' }),
      });
      [snapshot, actions] = transitionResult(machine, snapshot, task, output);
    }

    expect(snapshot.status).toBe('done');
    expect(snapshot.output).toEqual({
      thought: 'State machines make flow visible.',
      doodleQuery: 'statechart sketch',
    });
  });
});
