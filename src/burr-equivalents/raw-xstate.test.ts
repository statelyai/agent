import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { createActor, createAsyncLogic, toPromise, waitFor } from 'xstate';
import { createExampleSetup } from '../example-setup.test-utils.js';

describe('Burr-style examples authored as XState setup machines', () => {
  test('hello-world-counter uses explicit state and guarded looping', async () => {
    const agent = createExampleSetup({
      context: z.object({ counter: z.number(), countUpTo: z.number() }),
      input: z.object({ countUpTo: z.number() }),
      output: z.object({ counter: z.number() }),
      actors: {
        increment: createAsyncLogic<number, { counter: number }>({
          run: async ({ input }) => input.counter + 1,
        }),
      },
    });

    const machine = agent.createMachine({
      id: 'burr-counter-xstate',
      context: ({ input }) => ({ counter: 0, countUpTo: input.countUpTo }),
      initial: 'counter',
      states: {
        counter: {
          invoke: {
            src: 'increment',
            input: ({ context }) => ({ counter: context.counter }),
            onDone: ({ output }) => ({
              target: 'checking',
              context: { counter: output },
            }),
          },
        },
        checking: {
          always: ({ context }) =>
            context.counter < context.countUpTo
              ? { target: 'counter' }
              : { target: 'result' },
        },
        result: {
          type: 'final',
          output: ({ context }) => ({ counter: context.counter }),
        },
      },
    });

    const actor = createActor(machine, { input: { countUpTo: 3 } });
    actor.start();
    await toPromise(actor);

    expect(actor.getSnapshot().output).toEqual({ counter: 3 });
  });

  test('conversational RAG stores memory in machine context before answering', async () => {
    const agent = createExampleSetup({
      context: z.object({
        question: z.string(),
        memory: z.array(z.string()),
        documents: z.array(z.string()),
        answer: z.string().nullable(),
      }),
      input: z.object({
        question: z.string(),
        memory: z.array(z.string()).default([]),
      }),
      output: z.object({ answer: z.string(), memory: z.array(z.string()) }),
      actors: {
        retrieve: createAsyncLogic<string[], { question: string }>({
          run: async ({ input }) => [
            `doc:${input.question}`,
            'doc:remembered-state',
          ],
        }),
      },
      requests: {
        answerWithDocuments: {
          schemas: {
            input: z.object({
              question: z.string(),
              documents: z.array(z.string()),
              memory: z.array(z.string()),
            }),
            output: z.string(),
          },
          model: 'rag-answerer',
          prompt: ({ input }) =>
            [
              `Q: ${input.question}`,
              `Memory: ${input.memory.join(' | ')}`,
              `Docs: ${input.documents.join(' | ')}`,
            ].join('\n'),
        },
      },
    });

    const machine = agent.createMachine({
      id: 'burr-conversational-rag-xstate',
      context: ({ input }) => ({
        question: input.question,
        memory: input.memory,
        documents: [],
        answer: null,
      }),
      initial: 'retrieving',
      states: {
        retrieving: {
          invoke: {
            src: 'retrieve',
            input: ({ context }) => ({ question: context.question }),
            onDone: ({ output }) => ({
              target: 'answering',
              context: { documents: output },
            }),
          },
        },
        answering: {
          invoke: {
            src: 'answerWithDocuments',
            input: ({ context }) => ({
              question: context.question,
              documents: context.documents,
              memory: context.memory,
            }),
            onDone: ({ context, output }) => ({
              target: 'done',
              context: {
                answer: output,
                memory: [
                  ...context.memory,
                  context.question,
                  output,
                ],
              },
            }),
          },
        },
        done: {
          type: 'final',
          output: ({ context }) => ({
            answer: context.answer ?? '',
            memory: context.memory,
          }),
        },
      },
    });

    const actor = createActor(
      machine.provide({
        actorSources: {
          answerWithDocuments: agent.requests.answerWithDocuments.withExecutor(
            async ({ input }) =>
              `answer:${input.documents.join(',')}:memory=${input.memory.length}`,
          ),
        },
      }),
      { input: { question: 'why burr?', memory: ['prior turn'] } },
    );
    actor.start();
    await toPromise(actor);

    expect(actor.getSnapshot().output).toEqual({
      answer: 'answer:doc:why burr?,doc:remembered-state:memory=1',
      memory: [
        'prior turn',
        'why burr?',
        'answer:doc:why burr?,doc:remembered-state:memory=1',
      ],
    });
  });

  test('streaming-overview router keeps safety and mode as explicit states', async () => {
    const modeSchema = z.object({
      mode: z.enum([
        'answer_question',
        'generate_code',
        'generate_image',
        'unknown',
      ]),
    });
    const agent = createExampleSetup({
      context: z.object({
        prompt: z.string(),
        safe: z.boolean(),
        mode: modeSchema.shape.mode.nullable(),
        response: z.string().nullable(),
      }),
      input: z.object({ prompt: z.string() }),
      output: z.object({ response: z.string() }),
      requests: {
        chooseMode: {
          schemas: {
            input: z.object({ prompt: z.string() }),
            output: modeSchema,
          },
          model: 'mode-router',
          system: 'Choose the response mode.',
          prompt: ({ input }) => input.prompt,
        },
        answerPrompt: {
          mode: 'stream',
          schemas: {
            input: z.object({
              prompt: z.string(),
              mode: modeSchema.shape.mode,
            }),
            output: z.string(),
          },
          model: 'streaming-writer',
          prompt: ({ input }) => `${input.mode}:${input.prompt}`,
        },
      },
    });

    const machine = agent.createMachine({
      id: 'burr-streaming-router-xstate',
      context: ({ input }) => ({
        prompt: input.prompt,
        safe: false,
        mode: null,
        response: null,
      }),
      initial: 'checkSafety',
      states: {
        checkSafety: {
          entry: ({ context }) => ({
            context: { safe: !context.prompt.includes('unsafe') },
          }),
          always: ({ context }) =>
            context.safe
              ? { target: 'decideMode' }
              : { target: 'unsafeResponse' },
        },
        decideMode: {
          invoke: {
            src: 'chooseMode',
            input: ({ context }) => ({ prompt: context.prompt }),
            onDone: ({ output }) => ({
              target: 'route',
              context: { mode: output.mode },
            }),
          },
        },
        route: {
          always: ({ context }) =>
            context.mode === 'unknown'
              ? { target: 'promptForMore' }
              : { target: 'answering' },
        },
        answering: {
          invoke: {
            src: 'answerPrompt',
            input: ({ context }) => ({
              prompt: context.prompt,
              mode: context.mode ?? 'answer_question',
            }),
            onDone: ({ output }) => ({
              target: 'done',
              context: { response: output },
            }),
          },
        },
        promptForMore: {
          entry: () => ({ context: { response: 'Please clarify.' } }),
          always: { target: 'done' },
        },
        unsafeResponse: {
          entry: () => ({ context: { response: 'I cannot respond to that.' } }),
          always: { target: 'done' },
        },
        done: {
          type: 'final',
          output: ({ context }) => ({ response: context.response ?? '' }),
        },
      },
    });

    const chunks: string[] = [];
    const actor = createActor(
      machine.provide({
        actorSources: {
          chooseMode: agent.requests.chooseMode.withExecutor(async () => ({
            mode: 'generate_code',
          })),
          answerPrompt: agent.requests.answerPrompt.withExecutor(
            async ({ input }) => {
              chunks.push('chunk:1');
              chunks.push('chunk:2');
              return `response:${input.mode}:${input.prompt}`;
            },
          ),
        },
      }),
      { input: { prompt: 'write a TypeScript function' } },
    );
    actor.start();
    await toPromise(actor);

    expect(chunks).toEqual(['chunk:1', 'chunk:2']);
    expect(actor.getSnapshot().output).toEqual({
      response: 'response:generate_code:write a TypeScript function',
    });
  });

  test('tool-calling separates tool selection, tool execution, and final formatting', async () => {
    const selectedToolSchema = z.discriminatedUnion('tool', [
      z.object({
        tool: z.literal('queryWeather'),
        parameters: z.object({ latitude: z.number(), longitude: z.number() }),
      }),
      z.object({
        tool: z.literal('fallback'),
        parameters: z.object({ response: z.string() }),
      }),
    ]);
    const agent = createExampleSetup({
      context: z.object({
        query: z.string(),
        selected: selectedToolSchema.nullable(),
        rawResponse: z.record(z.string(), z.unknown()).nullable(),
        finalOutput: z.string().nullable(),
      }),
      input: z.object({ query: z.string() }),
      output: z.object({ finalOutput: z.string() }),
      actors: {
        queryWeather: createAsyncLogic<
          Record<string, unknown>,
          { latitude: number; longitude: number }
        >({
          run: async ({ input }) => ({
            forecast: 'sunny',
            location: `${input.latitude},${input.longitude}`,
          }),
        }),
        fallback: createAsyncLogic<Record<string, unknown>, { response: string }>({
          run: async ({ input }) => ({ response: input.response }),
        }),
      },
      requests: {
        selectTool: {
          schemas: {
            input: z.object({ query: z.string() }),
            output: selectedToolSchema,
          },
          model: 'tool-router',
          system: 'Select exactly one tool.',
          prompt: ({ input }) => input.query,
        },
        formatResult: {
          schemas: {
            input: z.object({
              query: z.string(),
              rawResponse: z.record(z.string(), z.unknown()),
            }),
            output: z.string(),
          },
          model: 'formatter',
          prompt: ({ input }) =>
            `Question: ${input.query}\nData: ${JSON.stringify(input.rawResponse)}`,
        },
      },
    });

    const machine = agent.createMachine({
      id: 'burr-tool-calling-xstate',
      context: ({ input }) => ({
        query: input.query,
        selected: null,
        rawResponse: null,
        finalOutput: null,
      }),
      initial: 'selectingTool',
      states: {
        selectingTool: {
          invoke: {
            src: 'selectTool',
            input: ({ context }) => ({ query: context.query }),
            onDone: ({ output }) => ({
              target: 'dispatch',
              context: { selected: output },
            }),
          },
        },
        dispatch: {
          always: ({ context }) =>
            context.selected?.tool === 'queryWeather'
              ? { target: 'queryingWeather' }
              : { target: 'fallingBack' },
        },
        queryingWeather: {
          invoke: {
            src: 'queryWeather',
            input: ({ context }) =>
              context.selected?.tool === 'queryWeather'
                ? context.selected.parameters
                : { latitude: 0, longitude: 0 },
            onDone: ({ output }) => ({
              target: 'formatting',
              context: { rawResponse: output },
            }),
          },
        },
        fallingBack: {
          invoke: {
            src: 'fallback',
            input: ({ context }) =>
              context.selected?.tool === 'fallback'
                ? context.selected.parameters
                : { response: 'No tool selected.' },
            onDone: ({ output }) => ({
              target: 'formatting',
              context: { rawResponse: output },
            }),
          },
        },
        formatting: {
          invoke: {
            src: 'formatResult',
            input: ({ context }) => ({
              query: context.query,
              rawResponse: context.rawResponse ?? {},
            }),
            onDone: ({ output }) => ({
              target: 'done',
              context: { finalOutput: output },
            }),
          },
        },
        done: {
          type: 'final',
          output: ({ context }) => ({ finalOutput: context.finalOutput ?? '' }),
        },
      },
    });

    const actor = createActor(
      machine.provide({
        actorSources: {
          selectTool: agent.requests.selectTool.withExecutor(async () => ({
            tool: 'queryWeather',
            parameters: { latitude: 37.77, longitude: -122.42 },
          })),
          formatResult: agent.requests.formatResult.withExecutor(
            async ({ input }) => `formatted:${input.rawResponse.forecast}`,
          ),
        },
      }),
      { input: { query: 'weather in San Francisco' } },
    );
    actor.start();
    await toPromise(actor);

    expect(actor.getSnapshot().output).toEqual({
      finalOutput: 'formatted:sunny',
    });
  });

  test('typed-state structured output remains schema-derived and testable', async () => {
    const conceptSchema = z.object({
      term: z.string(),
      definition: z.string(),
      timestamp: z.number(),
    });
    const postSchema = z.object({
      topic: z.string(),
      hook: z.string(),
      body: z.string(),
      concepts: z.array(conceptSchema),
      keyTakeaways: z.array(z.string()),
    });
    const agent = createExampleSetup({
      context: z.object({
        youtubeUrl: z.string(),
        transcript: z.string().nullable(),
        post: postSchema.nullable(),
      }),
      input: z.object({ youtubeUrl: z.string() }),
      output: z.object({ post: postSchema }),
      actors: {
        getTranscript: createAsyncLogic<string, { youtubeUrl: string }>({
          run: async ({ input }) => `transcript:${input.youtubeUrl}`,
        }),
      },
      requests: {
        generatePost: {
          schemas: {
            input: z.object({ transcript: z.string() }),
            output: postSchema,
          },
          model: 'post-writer',
          system: 'Generate a social media post from the transcript.',
          prompt: ({ input }) => input.transcript,
        },
      },
    });

    const machine = agent.createMachine({
      id: 'burr-typed-state-xstate',
      context: ({ input }) => ({
        youtubeUrl: input.youtubeUrl,
        transcript: null,
        post: null,
      }),
      initial: 'gettingTranscript',
      states: {
        gettingTranscript: {
          invoke: {
            src: 'getTranscript',
            input: ({ context }) => ({ youtubeUrl: context.youtubeUrl }),
            onDone: ({ output }) => ({
              target: 'generatingPost',
              context: { transcript: output },
            }),
          },
        },
        generatingPost: {
          invoke: {
            src: 'generatePost',
            input: ({ context }) => ({ transcript: context.transcript ?? '' }),
            onDone: ({ output }) => ({
              target: 'done',
              context: { post: output },
            }),
          },
        },
        done: {
          type: 'final',
          output: ({ context }) => ({
            post: context.post ?? {
              topic: '',
              hook: '',
              body: '',
              concepts: [],
              keyTakeaways: [],
            },
          }),
        },
      },
    });

    const actor = createActor(
      machine.provide({
        actorSources: {
          generatePost: agent.requests.generatePost.withExecutor(
            async ({ input }) => ({
              topic: 'Burr',
              hook: 'Stateful AI apps need structure.',
              body: input.transcript,
              concepts: [
                { term: 'state', definition: 'durable memory', timestamp: 1 },
              ],
              keyTakeaways: ['Keep state explicit'],
            }),
          ),
        },
      }),
      { input: { youtubeUrl: 'https://youtube.test/watch?v=abc' } },
    );
    actor.start();
    await toPromise(actor);

    expect(actor.getSnapshot().output?.post).toEqual(
      expect.objectContaining({
        topic: 'Burr',
        concepts: [
          { term: 'state', definition: 'durable memory', timestamp: 1 },
        ],
      }),
    );
  });

  test('multi-agent collaboration is supervisor routing over typed workers', async () => {
    const routeSchema = z.object({
      route: z.enum(['researcher', 'chartGenerator']),
    });
    const agent = createExampleSetup({
      context: z.object({
        request: z.string(),
        route: z.enum(['researcher', 'chartGenerator']).nullable(),
        result: z.string().nullable(),
      }),
      input: z.object({ request: z.string() }),
      output: z.object({ result: z.string() }),
      actors: {
        researcher: createAsyncLogic<string, { request: string }>({
          run: async ({ input }) => `research:${input.request}`,
        }),
        chartGenerator: createAsyncLogic<string, { request: string }>({
          run: async ({ input }) => `chart:${input.request}`,
        }),
      },
      requests: {
        routeWork: {
          schemas: {
            input: z.object({ request: z.string() }),
            output: routeSchema,
          },
          model: 'supervisor',
          prompt: ({ input }) => input.request,
        },
      },
    });

    const machine = agent.createMachine({
      id: 'burr-multi-agent-collaboration-xstate',
      context: ({ input }) => ({
        request: input.request,
        route: null,
        result: null,
      }),
      initial: 'supervising',
      states: {
        supervising: {
          invoke: {
            src: 'routeWork',
            input: ({ context }) => ({ request: context.request }),
            onDone: ({ output }) => ({
              target: 'dispatch',
              context: { route: output.route },
            }),
          },
        },
        dispatch: {
          always: ({ context }) =>
            context.route === 'chartGenerator'
              ? { target: 'charting' }
              : { target: 'researching' },
        },
        researching: {
          invoke: {
            src: 'researcher',
            input: ({ context }) => ({ request: context.request }),
            onDone: ({ output }) => ({
              target: 'done',
              context: { result: output },
            }),
          },
        },
        charting: {
          invoke: {
            src: 'chartGenerator',
            input: ({ context }) => ({ request: context.request }),
            onDone: ({ output }) => ({
              target: 'done',
              context: { result: output },
            }),
          },
        },
        done: {
          type: 'final',
          output: ({ context }) => ({ result: context.result ?? '' }),
        },
      },
    });

    const actor = createActor(
      machine.provide({
        actorSources: {
          routeWork: agent.requests.routeWork.withExecutor(async () => ({
            route: 'chartGenerator',
          })),
        },
      }),
      { input: { request: 'plot revenue' } },
    );
    actor.start();
    await toPromise(actor);

    expect(actor.getSnapshot().output).toEqual({
      result: 'chart:plot revenue',
    });
  });
});
