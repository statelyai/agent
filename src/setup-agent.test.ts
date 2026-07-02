import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import {
  createActor,
  createAsyncLogic,
  initialTransition,
  waitFor,
} from 'xstate';
import {
  createAgentSchemas,
  createTextLogic,
  executeAgentRequest,
  getAvailableEvents,
  getAgentOutputMode,
  getAgentRequests,
  getEventTools,
  getMachineAgentRequests,
  initialAgentStep,
  isStructuredOutputSchema,
  messagesSchema,
  parseOutput,
  resolveAgentStep,
  runAgent,
  setupAgent,
  toolMessage,
  transitionAgentStep,
  transitionResult,
  userMessage,
  type AgentTextRequest,
  type AgentTools,
  type AgentEventDescriptor,
} from './index.js';

describe('setupAgent', () => {
  test('setupAgent accepts schema-bound request configs', async () => {
    const schemas = createAgentSchemas({
      context: z.object({
        prompt: z.string(),
        draft: z.object({ body: z.string() }).nullable(),
      }),
      input: z.object({ prompt: z.string() }),
      output: z.object({ body: z.string() }),
      events: {
        READY_TO_DRAFT: z.object({}),
        NEEDS_INFO: z.object({ question: z.string() }),
      },
    });

    const agent = setupAgent({
      schemas,
      requests: {
        draftEmail: {
          mode: 'generate',
          schemas: {
            input: z.object({ prompt: z.string() }),
            output: z.object({ body: z.string() }),
          },
          model: 'test-model',
          prompt: ({ input }) => input.prompt,
          agentEvents: ({ input, schemas }) => {
            const prompt: string = input.prompt;
            schemas.events.READY_TO_DRAFT;
            // @ts-expect-error request agentEvents input is typed from schemas.input
            input.body;
            return prompt.length > 0 ? ['READY_TO_DRAFT'] : [];
          },
        },
        streamRevision: {
          mode: 'stream',
          schemas: {
            input: z.object({ body: z.string() }),
            output: z.object({ body: z.string() }),
          },
          model: 'test-model',
          prompt: ({ input }) => input.body,
        },
      },
    });

    setupAgent({
      schemas,
      requests: {
        badKind: {
          // @ts-expect-error request mode is constrained
          mode: 'foo',
          schemas: {
            input: z.object({ prompt: z.string() }),
            output: z.object({ body: z.string() }),
          },
          model: 'test-model',
          prompt: ({ input }) => input.prompt,
        },
      },
    });

    setupAgent({
      schemas,
      requests: {
        badEvent: {
          schemas: {
            input: z.object({ prompt: z.string() }),
            output: z.object({ body: z.string() }),
          },
          model: 'test-model',
          prompt: ({ input }) => input.prompt,
          // @ts-expect-error agentEvents are keyed by machine event schemas
          agentEvents: ['DRAT_EMAIL_TYPO'],
        },
      },
    });

    setupAgent({
      schemas,
      requests: {
        legacyEvents: {
          schemas: {
            input: z.object({ prompt: z.string() }),
            output: z.object({ body: z.string() }),
          },
          model: 'test-model',
          prompt: ({ input }) => input.prompt,
          // @ts-expect-error use agentEvents for request-level machine event tools
          events: ['READY_TO_DRAFT'],
        },
      },
    });

    setupAgent({
      schemas,
      requests: {
        badEventTypes: {
          schemas: {
            input: z.object({ prompt: z.string() }),
            output: z.object({ body: z.string() }),
          },
          model: 'test-model',
          prompt: ({ input }) => input.prompt,
          // @ts-expect-error use request events, not raw text logic eventTypes
          eventTypes: ['READY_TO_DRAFT'],
        },
      },
    });

    agent.createMachine({
      context: ({ input }) => ({ prompt: input.prompt, draft: null }),
      initial: 'drafting',
      states: {
        drafting: {
          // @ts-expect-error invoke sources are checked against configured actors
          invoke: {
            src: 'dratemaltypo',
            input: { prompt: 'Draft it.' },
          },
        },
      },
    });

    agent.createMachine({
      context: ({ input }) => ({ prompt: input.prompt, draft: null }),
      initial: 'drafting',
      states: {
        drafting: {
          invoke: {
            src: 'draftEmail',
            // @ts-expect-error invoke input must match the actor input schema
            input: { whoopsanything: 42 },
          },
        },
      },
    });

    const machine = agent.createMachine({
      context: ({ input }) => ({ prompt: input.prompt, draft: null }),
      initial: 'drafting',
      states: {
        drafting: {
          invoke: {
            id: 'draft',
            src: 'draftEmail',
            input: ({ context }) => ({ prompt: context.prompt }),
            onDone: ({ output }) => ({
              target: 'done',
              context: { draft: output },
            }),
          },
        },
        done: {
          type: 'final',
          output: ({ context }) => context.draft ?? { body: '' },
        },
      },
    });

    const [_snapshot, actions] = initialTransition(machine, {
      prompt: 'Draft it.',
    });
    const [request] = getMachineAgentRequests(machine, actions);

    expect(agent.requests.draftEmail.mode).toBe('generate');
    expect(agent.requests.draftEmail.request({ prompt: 'Draft it.' })).toEqual(
      expect.objectContaining({
        model: 'test-model',
        prompt: 'Draft it.',
        eventTypes: ['READY_TO_DRAFT'],
      }),
    );

    expect(request).toEqual(
      expect.objectContaining({
        mode: 'generate',
        input: expect.objectContaining({ eventTypes: ['READY_TO_DRAFT'] }),
      }),
    );

    expect(getMachineAgentRequests(machine, actions)).toEqual([request]);

    await expect(
      agent.requests.draftEmail.execute(
        { prompt: 'Draft it.' },
        {
          generateText: async (request) => {
            expect(request.prompt).toBe('Draft it.');
            expect(request.eventTypes).toEqual(['READY_TO_DRAFT']);
            return { output: { body: 'Standalone body.' } };
          },
        },
      ),
    ).resolves.toEqual({ body: 'Standalone body.' });
  });

  test('agent machines execute generated and streamed requests with host callbacks', async () => {
    const schemas = createAgentSchemas({
      context: z.object({ prompt: z.string(), body: z.string().nullable() }),
      input: z.object({ prompt: z.string() }),
      output: z.object({ body: z.string() }),
    });
    const agent = setupAgent({
      schemas,
      requests: {
        draftEmail: {
          schemas: {
            input: z.object({ prompt: z.string() }),
            output: z.object({ body: z.string() }),
          },
          model: 'test-model',
          prompt: ({ input }) => input.prompt,
        },
        streamRevision: {
          mode: 'stream',
          schemas: {
            input: z.object({ body: z.string() }),
            output: z.string(),
          },
          model: 'test-model',
          prompt: ({ input }) => input.body,
        },
      },
    });

    const generateMachine = agent.createMachine({
      context: ({ input }) => ({ prompt: input.prompt, body: null }),
      initial: 'drafting',
      states: {
        drafting: {
          invoke: {
            id: 'draft',
            src: 'draftEmail',
            input: ({ context }) => ({ prompt: context.prompt }),
          },
        },
      },
    });
    const [_generateSnapshot, generateActions] = initialTransition(
      generateMachine,
      { prompt: 'Draft it.' },
    );
    const [generateTask] = getMachineAgentRequests(generateMachine, generateActions);

    await expect(
      executeAgentRequest(generateTask!, {
        generateText: async (
          request: AgentTextRequest & { tools: AgentTools },
        ) => {
          expect(request).toEqual(
            expect.objectContaining({
              model: 'test-model',
              prompt: 'Draft it.',
              outputSchema: agent.requests.draftEmail.schemas.output,
              tools: {},
            }),
          );
          return { output: { body: 'Generated body.' } };
        },
      }),
    ).resolves.toEqual({ body: 'Generated body.' });

    const streamMachine = agent.createMachine({
      context: ({ input }) => ({ prompt: input.prompt, body: null }),
      initial: 'streaming',
      states: {
        streaming: {
          invoke: {
            id: 'stream',
            src: 'streamRevision',
            input: () => ({ body: 'Draft body.' }),
          },
        },
      },
    });
    const [_streamSnapshot, streamActions] = initialTransition(streamMachine, {
      prompt: 'Revise it.',
    });
    const [streamTask] = getMachineAgentRequests(streamMachine, streamActions);

    await expect(
      executeAgentRequest(streamTask!, {
        generateText: async () => {
          throw new Error('streamText should be used for stream requests');
        },
        streamText: async (
          request: AgentTextRequest & { tools: AgentTools },
        ) => {
          expect(request.prompt).toBe('Draft body.');
          return { text: Promise.resolve('Streamed final text.') };
        },
      }),
    ).resolves.toBe('Streamed final text.');
  });

  test('setupAgent auto-provides built-in generateText and streamText sources', async () => {
    const answerSchema = z.object({ answer: z.string() });
    const schemas = createAgentSchemas({
      context: z.object({
        prompt: z.string(),
        answer: z.string().nullable(),
        streamed: z.string().nullable(),
      }),
      input: z.object({ prompt: z.string() }),
      output: z.object({
        answer: z.string(),
        streamed: z.string(),
      }),
    });
    const agent = setupAgent({ schemas });
    const machine = agent.createMachine({
      context: ({ input }) => ({
        prompt: input.prompt,
        answer: null,
        streamed: null,
      }),
      initial: 'answering',
      states: {
        answering: {
          invoke: {
            id: 'answer',
            src: 'agent.generateText',
            input: ({ context }) => ({
              model: 'test-model',
              prompt: context.prompt,
              outputSchema: answerSchema,
              temperature: 0.2,
            }),
            onDone: ({ output }) => ({
              target: 'streaming',
              context: { answer: parseOutput(answerSchema, output).answer },
            }),
          },
        },
        streaming: {
          invoke: {
            id: 'stream',
            src: 'agent.streamText',
            input: ({ context }) => ({
              model: 'test-model',
              prompt: `Expand ${context.answer}`,
            }),
            onDone: ({ output }) => ({
              target: 'done',
              context: { streamed: output as string },
            }),
          },
        },
        done: {
          type: 'final',
          output: ({ context }) => {
            const typedContext = context as {
              answer: string | null;
              streamed: string | null;
            };
            return {
              answer: typedContext.answer ?? '',
              streamed: typedContext.streamed ?? '',
            };
          },
        },
      },
    });

    let step = initialAgentStep(machine, { prompt: 'Why machines?' });
    expect(step.requests).toEqual([
      expect.objectContaining({
        mode: 'generate',
        id: 'answer',
        src: 'agent.generateText',
        input: expect.objectContaining({
          model: 'test-model',
          prompt: 'Why machines?',
          outputSchema: answerSchema,
          temperature: 0.2,
        }),
      }),
    ]);

    const answer = await executeAgentRequest(step.requests[0]!, {
      generateText: async (
        request: AgentTextRequest & { tools: AgentTools },
      ) => {
        expect(request.tools).toEqual({});
        return { output: { answer: `Answered ${request.prompt}` } };
      },
    });
    step = resolveAgentStep(machine, step, step.requests[0]!, answer);

    expect(step.requests).toEqual([
      expect.objectContaining({
        mode: 'stream',
        id: 'stream',
        src: 'agent.streamText',
        input: expect.objectContaining({
          model: 'test-model',
          prompt: 'Expand Answered Why machines?',
        }),
      }),
    ]);

    const streamed = await executeAgentRequest(step.requests[0]!, {
      generateText: async () => {
        throw new Error('generateText should not be used for stream requests');
      },
      streamText: async (
        request: AgentTextRequest & { tools: AgentTools },
      ) => ({
        text: `Streamed ${request.prompt}`,
      }),
    });
    step = resolveAgentStep(machine, step, step.requests[0]!, streamed);

    expect(step.done).toBe(true);
    expect(step.snapshot.output).toEqual({
      answer: 'Answered Why machines?',
      streamed: 'Streamed Expand Answered Why machines?',
    });
  });

  test('provided agent machines preserve step helpers', () => {
    const agent = setupAgent({
      context: z.object({ prompt: z.string() }),
      input: z.object({ prompt: z.string() }),
      requests: {
        answer: {
          schemas: {
            input: z.object({ prompt: z.string() }),
            output: z.object({ answer: z.string() }),
          },
          model: 'test-model',
          prompt: ({ input }) => input.prompt,
        },
      },
    });

    const machine = agent.createMachine({
      context: ({ input }) => ({ prompt: input.prompt }),
      initial: 'answering',
      states: {
        answering: {
          invoke: {
            id: 'answer',
            src: 'answer',
            input: ({ context }) => ({ prompt: context.prompt }),
          },
        },
      },
    });
    const provided = machine.provide({ actorSources: {} });
    const step = initialAgentStep(provided, { prompt: 'hello' });

    expect(agent.getRequests(provided, step.actions, step.snapshot)).toHaveLength(1);
    expect(typeof agent.execute).toBe('function');
    expect(typeof agent.resolve).toBe('function');
  });

  test('agent machine step execution validates request output schemas', async () => {
    const agent = setupAgent({
      context: z.object({ prompt: z.string() }),
      input: z.object({ prompt: z.string() }),
      requests: {
        answer: {
          schemas: {
            input: z.object({ prompt: z.string() }),
            output: z.object({ answer: z.string() }),
          },
          model: 'test-model',
          prompt: ({ input }) => input.prompt,
        },
      },
    });

    const machine = agent.createMachine({
      context: ({ input }) => ({ prompt: input.prompt }),
      initial: 'answering',
      states: {
        answering: {
          invoke: {
            id: 'answer',
            src: 'answer',
            input: ({ context }) => ({ prompt: context.prompt }),
          },
        },
      },
    });
    const step = initialAgentStep(machine, { prompt: 'hello' });

    await expect(
      executeAgentRequest(step.requests[0]!, {
        generateText: () => ({ answer: 123 }),
      }),
    ).rejects.toThrow('expected string');
  });

  test('setupAgent preserves typed action guard and delay names', () => {
    const schemas = createAgentSchemas({
      context: z.object({ prompt: z.string(), ready: z.boolean() }),
      input: z.object({ prompt: z.string() }),
      events: {
        MARK_READY: z.object({ reason: z.string() }),
      },
    });

    const agent = setupAgent({
      schemas,
      actions: {
        markReady: ({ event }: { event: { type: string; reason?: string } }) => {
          if (event.type === 'MARK_READY') {
            const reason = event.reason ?? '';
            return { context: { ready: reason.length > 0 } };
          }
          return { context: { ready: false } };
        },
      },
      guards: {
        hasPrompt: ({ context }: { context: { prompt: string } }) =>
          context.prompt.length > 0,
      },
      delays: {
        shortPause: ({ context }: { context: { prompt: string } }) =>
          context.prompt.length,
      },
    });

    agent.createMachine({
      context: ({ input }) => ({ prompt: input.prompt, ready: false }),
      initial: 'waiting',
      states: {
        waiting: {
          entry: ({ actions }, enq) => enq(actions.markReady!),
          always: ({ context, guards }) =>
            guards.hasPrompt!({ context } as never)
              ? { target: 'done' }
              : undefined,
          after: { shortPause: { target: 'done' } },
          on: {
            MARK_READY: ({ actions }, enq) => enq(actions.markReady!),
          },
        },
        done: { type: 'final' },
      },
    });

    agent.createMachine({
      context: ({ input }) => ({ prompt: input.prompt, ready: false }),
      initial: 'waiting',
      states: {
        waiting: {
          entry: ({ actions }, enq) => {
            enq(actions.markReadtypo!);
          },
        },
      },
    });

    agent.createMachine({
      context: ({ input }) => ({ prompt: input.prompt, ready: false }),
      initial: 'waiting',
      states: {
        waiting: {
          always: {
            guard: 'hasPromptypo',
            target: 'done',
          },
        },
        done: { type: 'final' },
      },
    });
  });

  test('appendMessages creates a typed action for message context', async () => {
    const schemas = createAgentSchemas({
      context: z.object({
        messages: messagesSchema,
      }),
      input: z.object({}),
      events: {
        USER_REPLIED: z.object({ text: z.string() }),
      },
    });
    const agent = setupAgent({ schemas });
    const machine = agent.createMachine({
      context: { messages: [] },
      initial: 'waiting',
      states: {
        waiting: {
          on: {
            USER_REPLIED: agent.appendMessages(({ event }) => {
                const text: string = event.text;
                return userMessage(text);
              }) as never,
          },
        },
      },
    });

    const actor = createActor(machine);
    actor.start();
    actor.send({ type: 'USER_REPLIED', text: 'hello' } as never);

    expect(actor.getSnapshot().context.messages).toEqual([
      { role: 'user', content: 'hello' },
    ]);
  });

  test('toolMessage builds a tool-role message from tool-result parts', () => {
    const message = toolMessage([
      {
        type: 'tool-result',
        toolCallId: 'call_1',
        toolName: 'lookup',
        output: { type: 'text', value: 'found it' },
      },
    ]);

    expect(message).toEqual({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'call_1',
          toolName: 'lookup',
          output: { type: 'text', value: 'found it' },
        },
      ],
    });
  });

  test('messagesSchema accepts a valid tool message and a parts-array user message', () => {
    const result = messagesSchema['~standard'].validate([
      {
        role: 'user',
        content: [{ type: 'text', text: 'hello' }],
      },
      toolMessage([
        {
          type: 'tool-result',
          toolCallId: 'call_1',
          toolName: 'lookup',
          output: { type: 'json', value: { ok: true } },
        },
      ]),
    ]);

    expect(result.issues).toBeUndefined();
  });

  test('messagesSchema rejects an unknown role', () => {
    const result = messagesSchema['~standard'].validate([
      { role: 'developer', content: 'hi' },
    ]);

    expect(result.issues).toBeDefined();
    expect(result.issues![0]!.message).toMatch(/unknown message role/i);
  });

  test('messagesSchema rejects an unknown part type', () => {
    const result = messagesSchema['~standard'].validate([
      {
        role: 'user',
        content: [{ type: 'video', url: 'https://example.com/clip.mp4' }],
      },
    ]);

    expect(result.issues).toBeDefined();
    expect(result.issues![0]!.message).toMatch(/unknown message part type/i);
  });

  test('authors reusable text actors with typed input and output', async () => {
    const getSummary = createTextLogic({
      mode: 'generate',
      schemas: {
        input: z.object({ article: z.string() }),
        output: z.object({ summary: z.string() }),
      },
      model: 'test-model',
      system: 'Summarize articles.',
      prompt: ({ input }) => `Summarize:\n${input.article}`,
      temperature: ({ input }) => (input.article.length > 10 ? 0.2 : 0),
    });
    const agent = setupAgent({
      context: z.object({
        article: z.string(),
        summary: z.string().nullable(),
      }),
      input: z.object({ article: z.string() }),
      output: z.object({ summary: z.string() }),
      actors: {
        getSummary,
      },
    });

    expect(getSummary.request({ article: 'A long article.' })).toEqual(
      expect.objectContaining({
        model: 'test-model',
        system: 'Summarize articles.',
        prompt: 'Summarize:\nA long article.',
        outputSchema: getSummary.schemas.output,
        temperature: 0.2,
      }),
    );

    agent.createMachine({
      context: ({ input }) => ({ article: input.article, summary: null }),
      initial: 'summarizing',
      states: {
        summarizing: {
          // @ts-expect-error invoke sources are checked against configured actors
          invoke: {
            src: 'getSummar',
            input: { article: 'typo' },
          },
        },
      },
    });

    agent.createMachine({
      context: ({ input }) => ({ article: input.article, summary: null }),
      initial: 'summarizing',
      states: {
        summarizing: {
          // @ts-expect-error invoke input must match the actor input schema
          invoke: {
            id: 'getSummary',
            src: 'getSummary',
            input: ({ context }) => ({ prompt: context.article }),
          },
        },
      },
    });

    const machine = agent.createMachine({
      context: ({ input }) => ({ article: input.article, summary: null }),
      initial: 'summarizing',
      states: {
        summarizing: {
          invoke: {
            id: 'getSummary',
            src: 'getSummary',
            input: ({ context }) => ({ article: context.article }),
            onDone: ({ output }) => ({
              target: 'done',
              context: {
                summary: (() => {
                  const summary: string = output.summary;
                  return summary;
                })(),
              },
            }),
          },
        },
        done: {
          type: 'final',
          output: ({ context }) => ({ summary: context.summary ?? '' }),
        },
      },
    });

    let [snapshot, actions] = initialTransition(machine, {
      article: 'State machines make agents inspectable.',
    });
    const [request] = getAgentRequests(actions, {
      actors: { getSummary },
    });

    expect(request).toEqual({
      id: 'getSummary',
      src: 'getSummary',
      mode: 'generate',
      input: expect.objectContaining({
        model: 'test-model',
        system: 'Summarize articles.',
        prompt: 'Summarize:\nState machines make agents inspectable.',
        outputSchema: getSummary.schemas.output,
      }),
      tools: {},
      events: [],
    });

    [snapshot] = transitionResult(machine, snapshot, request!, {
      summary: 'Agents become inspectable.',
    });

    expect(snapshot.status).toBe('done');
    expect(snapshot.output).toEqual({ summary: 'Agents become inspectable.' });

    await expect(
      getSummary.execute(
        { article: 'A long article.' },
        {
          generateText: async (
            request: AgentTextRequest & { tools: AgentTools },
          ) => {
            expect(request.prompt).toBe('Summarize:\nA long article.');
            expect(request.tools).toEqual({});
            return { output: { summary: 'Standalone summary.' } };
          },
        },
      ),
    ).resolves.toEqual({ summary: 'Standalone summary.' });
  });

  test('reusable stream text actors execute with streamText', async () => {
    const streamSummary = createTextLogic({
      mode: 'stream',
      schemas: {
        input: z.object({ article: z.string() }),
        output: z.string(),
      },
      model: 'test-model',
      prompt: ({ input }) => `Stream:\n${input.article}`,
    });
    const agent = setupAgent({
      context: z.object({ article: z.string() }),
      input: z.object({ article: z.string() }),
      actors: { streamSummary },
    });
    const machine = agent.createMachine({
      context: ({ input }) => ({ article: input.article }),
      initial: 'streaming',
      states: {
        streaming: {
          invoke: {
            id: 'streamSummary',
            src: 'streamSummary',
            input: ({ context }) => ({ article: context.article }),
          },
        },
      },
    });
    const step = initialAgentStep(machine, { article: 'State machines.' });

    expect(step.requests[0]).toEqual(
      expect.objectContaining({
        mode: 'stream',
        src: 'streamSummary',
      }),
    );
    await expect(
      executeAgentRequest(step.requests[0]!, {
        generateText: async () => {
          throw new Error('generateText should not be used');
        },
        streamText: async (
          request: AgentTextRequest & { tools: AgentTools },
        ) => {
          expect(request.prompt).toBe('Stream:\nState machines.');
          return { text: 'streamed summary' };
        },
      }),
    ).resolves.toBe('streamed summary');

    await expect(
      streamSummary.execute(
        { article: 'State machines.' },
        {
          generateText: async () => {
            throw new Error('generateText should not be used');
          },
          streamText: async (
            request: AgentTextRequest & { tools: AgentTools },
          ) => {
            expect(request.prompt).toBe('Stream:\nState machines.');
            expect(request.tools).toEqual({});
            return { text: 'standalone stream' };
          },
        },
      ),
    ).resolves.toBe('standalone stream');
  });

  test('named text logic can optionally execute as a promise actor', async () => {
    const answerQuestion = createTextLogic(
      {
        schemas: {
          input: z.object({ question: z.string() }),
          output: z.object({ answer: z.string() }),
        },
        model: 'test-model',
        prompt: ({ input }) => input.question,
      },
      async ({ input, request, signal }) => {
        expect(signal).toBeInstanceOf(AbortSignal);
        return {
          answer: `${request.model}:${input.question}`,
        };
      },
    );

    const agent = setupAgent({
      context: z.object({
        question: z.string(),
        answer: z.string().nullable(),
      }),
      input: z.object({ question: z.string() }),
      output: z.object({ answer: z.string() }),
      actors: { answerQuestion },
    });

    const machine = agent.createMachine({
      context: ({ input }) => ({ question: input.question, answer: null }),
      initial: 'answering',
      states: {
        answering: {
          invoke: {
            src: 'answerQuestion',
            input: ({ context }) => ({ question: context.question }),
            onDone: ({ output }) => ({
              target: 'done',
              context: { answer: output.answer },
            }),
          },
        },
        done: {
          type: 'final',
          output: ({ context }) => ({ answer: context.answer ?? '' }),
        },
      },
    });

    const actor = createActor(machine, {
      input: { question: 'can text logic run?' },
    });
    actor.start();
    await waitFor(actor, (snapshot) => snapshot.status === 'done');

    expect(actor.getSnapshot().output).toEqual({
      answer: 'test-model:can text logic run?',
    });
  });

  test('named text logic validates executor output', async () => {
    const answerQuestion = createTextLogic(
      {
        schemas: {
          input: z.object({ question: z.string() }),
          output: z.object({ answer: z.string() }),
        },
        model: 'test-model',
        prompt: ({ input }) => input.question,
      },
      async () => ({ nope: true }) as unknown as { answer: string },
    );

    const agent = setupAgent({
      context: z.object({
        question: z.string(),
        error: z.string().nullable(),
      }),
      input: z.object({ question: z.string() }),
      actors: { answerQuestion },
    });

    const machine = agent.createMachine({
      context: ({ input }) => ({ question: input.question, error: null }),
      initial: 'answering',
      states: {
        answering: {
          invoke: {
            src: 'answerQuestion',
            input: ({ context }) => ({ question: context.question }),
            onError: ({ event }) => ({
              target: 'failed',
              context: {
                error:
                  event.error instanceof Error
                    ? event.error.message
                    : String(event.error),
              },
            }),
          },
        },
        failed: {},
      },
    });

    const actor = createActor(machine, {
      input: { question: 'is output validated?' },
    });
    actor.start();
    await waitFor(actor, (snapshot) => snapshot.matches('failed'));

    expect(actor.getSnapshot().context.error).toContain('expected string');
  });

  test('authors raw XState machines from the root export', async () => {
    const draftSchema = z.object({
      subject: z.string(),
      body: z.string(),
    });
    const agent = setupAgent({
      context: z.object({
        prompt: z.string(),
        draft: draftSchema.nullable(),
      }),
      input: z.object({ prompt: z.string() }),
      output: draftSchema,
      events: {
        RETRY: z.object({ prompt: z.string() }),
      },
      requests: {
        draftEmail: {
          schemas: {
            input: z.object({ prompt: z.string() }),
            output: draftSchema,
          },
          model: 'test-model',
          prompt: ({ input }) => input.prompt,
          metadata: ({ input }) => ({
            temperature: input.prompt.length > 0 ? 0.2 : 0,
            traceId: `draft:${input.prompt}`,
          }),
        },
      },
    });
    const { draftEmail } = agent.requests;

    agent.createMachine({
      context: ({ input }) => ({ prompt: input.prompt, draft: null }),
      initial: 'drafting',
      states: {
        drafting: {
          // @ts-expect-error invoke sources are checked against configured actors
          invoke: {
            id: 'draft',
            src: 'draftEmai',
            input: { prompt: 'misspelled source' },
          },
        },
      },
    });

    const machine = agent.createMachine({
      id: 'raw-xstate-email-drafter',
      context: ({ input }) => ({ prompt: input.prompt, draft: null }),
      initial: 'drafting',
      states: {
        drafting: {
          invoke: {
            id: 'draft',
            src: 'draftEmail',
            input: ({ context }) => ({ prompt: context.prompt }),
            onDone: ({ output }) => ({
              target: 'review',
              context: {
                draft: (() => {
                  const draft = output;
                  const subject: string = draft.subject;
                  return { ...draft, subject };
                })(),
              },
            }),
          },
        },
        review: {
          on: {
            RETRY: ({ event }) => ({
              target: 'drafting',
              context: { prompt: (event as unknown as { prompt: string }).prompt },
            }),
          },
        },
        done: {
          type: 'final',
          output: ({ context }) => context.draft ?? { subject: '', body: '' },
        },
      },
    });

    const calls: AgentTextRequest<{ temperature: number; traceId: string }>[] =
      [];
    const actor = createActor(
      machine.provide({
        actorSources: {
          draftEmail: draftEmail.withExecutor(async ({ request }) => {
            calls.push(
              request as AgentTextRequest<{
                temperature: number;
                traceId: string;
              }>,
            );
            return {
              subject: `Re: ${request.prompt}`,
              body: 'Typed raw XState machine body.',
            };
          }),
        },
      }),
      { input: { prompt: 'launch note' } },
    );

    actor.start();

    await waitFor(actor, (snapshot) => snapshot.matches('review'));

    expect(actor.getSnapshot().context.draft).toEqual({
      subject: 'Re: launch note',
      body: 'Typed raw XState machine body.',
    });
    expect(calls).toEqual([
      expect.objectContaining({
        model: 'test-model',
        prompt: 'launch note',
        outputSchema: draftEmail.schemas.output,
        metadata: { temperature: 0.2, traceId: 'draft:launch note' },
      }),
    ]);
  });

  test('extracts agent requests from pure XState transitions', async () => {
    const answerSchema = z.object({ answer: z.string() });
    const agent = setupAgent({
      context: z.object({
        prompt: z.string(),
        answer: z.string().nullable(),
      }),
      input: z.object({ prompt: z.string() }),
      output: z.object({ answer: z.string() }),
      requests: {
        answerQuestion: {
          schemas: {
            input: z.object({ prompt: z.string() }),
            output: answerSchema,
          },
          model: 'test-model',
          prompt: ({ input }) => input.prompt,
          temperature: 0.2,
        },
      },
    });
    const { answerQuestion } = agent.requests;

    const machine = agent.createMachine({
      id: 'pure-agent-loop',
      context: ({ input }) => ({ prompt: input.prompt, answer: null }),
      initial: 'answering',
      states: {
        answering: {
          invoke: {
            id: 'answer',
            src: 'answerQuestion',
            input: ({ context }) => ({ prompt: context.prompt }),
            onDone: ({ output }) => ({
              target: 'done',
              context: { answer: output.answer },
            }),
          },
        },
        done: {
          type: 'final',
          output: ({ context }) => ({ answer: context.answer ?? '' }),
        },
      },
    });

    let [snapshot, actions] = initialTransition(machine, {
      prompt: 'why state machines?',
    });
    const [request] = getMachineAgentRequests(machine, actions);

    expect(request).toEqual({
      id: 'answer',
      src: 'answerQuestion',
      mode: 'generate',
      input: expect.objectContaining({
        model: 'test-model',
        prompt: 'why state machines?',
        temperature: 0.2,
        outputSchema: answerQuestion.schemas.output,
      }),
      tools: {},
      events: [],
    });

    [snapshot, actions] = transitionResult(machine, snapshot, request!, {
      answer: 'Because the workflow matters.',
    });

    expect(getAgentRequests(actions)).toEqual([]);
    expect(snapshot.status).toBe('done');
    expect(snapshot.output).toEqual({
      answer: 'Because the workflow matters.',
    });

    let step = initialAgentStep(machine, {
      prompt: 'why agent machines?',
    });
    expect(step.done).toBe(false);
    expect(step.requests).toHaveLength(1);
    expect(step.requests[0]).toEqual(
      expect.objectContaining({
        id: 'answer',
        src: 'answerQuestion',
      }),
    );

    const output = await executeAgentRequest(step.requests[0]!, {
      generateText: (request: AgentTextRequest & { tools: AgentTools }) => ({
        object: {
          answer: `Answered: ${request.prompt}`,
        },
      }),
    });
    step = resolveAgentStep(machine, step, step.requests[0]!, output);

    expect(step.done).toBe(true);
    expect(step.snapshot.output).toEqual({
      answer: 'Answered: why agent machines?',
    });

    const runOutput = await runAgent(machine, {
      input: { prompt: 'why run agents?' },
      generateText: (request: AgentTextRequest & { tools: AgentTools }) => ({
        object: {
          answer: `Ran: ${request.prompt}`,
        },
      }),
    });
    expect(runOutput).toEqual({ answer: 'Ran: why run agents?' });
  });

  test('detects structured output schemas separately from validation-only schemas', () => {
    const objectSchema = z.object({ answer: z.string() });
    const stringSchema = z.string();

    expect(getAgentOutputMode(objectSchema)).toBe('structured');
    expect(isStructuredOutputSchema(objectSchema)).toBe(true);
    expect(getAgentOutputMode(stringSchema)).toBe('text');
    expect(isStructuredOutputSchema(stringSchema)).toBe(false);
  });

  test('agent requests expose only selected state events as tools', async () => {
    const agent = setupAgent({
      context: z.object({ prompt: z.string() }),
      input: z.object({ prompt: z.string() }),
      events: {
        ATTACK: z.object({ target: z.string() }),
        DEFEND: z.object({}),
        PAUSE: z.object({}),
      },
      requests: {
        chooseMove: {
          schemas: {
            input: z.object({ prompt: z.string() }),
            output: z.string(),
          },
          model: 'test-model',
          prompt: ({ input }) => input.prompt,
          agentEvents: ['ATTACK', 'DEFEND'],
        },
      },
    });

    const machine = agent.createMachine({
      id: 'game-agent',
      context: ({ input }) => ({ prompt: input.prompt }),
      initial: 'choosing',
      states: {
        choosing: {
          invoke: {
            id: 'chooseMove',
            src: 'chooseMove',
            input: ({ context }) => ({ prompt: context.prompt }),
            onDone: { target: 'done' },
          },
          on: {
            ATTACK: { target: 'done' },
            DEFEND: { target: 'done' },
            PAUSE: { target: 'paused' },
          },
        },
        paused: {},
        done: { type: 'final' },
      },
    });

    const [snapshot, actions] = initialTransition(machine, {
      prompt: 'Choose the next move.',
    });
    const initialStep = initialAgentStep(machine, { prompt: 'Choose the next move.' });
    const attackStep = transitionAgentStep(machine, initialStep, {
      type: 'ATTACK',
    });

    expect(attackStep.done).toBe(true);

    expect(
      getAvailableEvents(snapshot, {
        schemas: agent.schemas,
        eventTypes: ['ATTACK', 'DEFEND', 'HEAL'],
      }),
    ).toEqual([
      expect.objectContaining({ type: 'ATTACK', toolName: 'send_event_ATTACK' }),
      expect.objectContaining({ type: 'DEFEND', toolName: 'send_event_DEFEND' }),
    ]);

    expect(
      getAvailableEvents(snapshot, {
        schemas: agent.schemas,
        eventTypes: ['ATTACK'],
        eventToolName: ({ eventType }) => `machine_${eventType.toLowerCase()}`,
      }),
    ).toEqual([
      expect.objectContaining({ type: 'ATTACK', toolName: 'machine_attack' }),
    ]);

    const [request] = getMachineAgentRequests(machine, actions, snapshot);
    const [customNamedRequest] = getMachineAgentRequests(machine, actions, snapshot, {
      eventToolName: ({ eventType }: { eventType: string }) =>
        `machine_${eventType.toLowerCase()}`,
    });

    expect(
      request!.events.map((event: AgentEventDescriptor) => event.type),
    ).toEqual([
      'ATTACK',
      'DEFEND',
    ]);
    expect(Object.keys(request!.tools)).toEqual([
      'send_event_ATTACK',
      'send_event_DEFEND',
    ]);
    expect(Object.keys(customNamedRequest!.tools)).toEqual([
      'machine_attack',
      'machine_defend',
    ]);

    const attackTool = request!.tools['send_event_ATTACK']!;
    if (typeof attackTool === 'function') {
      throw new Error('Expected event tool descriptor.');
    }
    expect(attackTool.description).toBe(
      "Send the 'ATTACK' event. Available from the current state."
    );
    await expect(attackTool.execute?.({ target: 'orc' })).resolves.toEqual({
      type: 'ATTACK',
      target: 'orc',
    });

    expect(
      Object.keys(
        getEventTools(snapshot, {
          schemas: agent.schemas,
          eventTypes: ['ATTACK', 'DEFEND', 'HEAL'],
        }),
      ),
    ).toEqual(['send_event_ATTACK', 'send_event_DEFEND']);
  });

  test('fromConfig lowers static request workflows to agent machine steps', async () => {
    const machine = setupAgent.fromConfig({
      id: 'static-answer',
      schemas: {
        input: {
          type: 'object',
          properties: {
            question: { type: 'string' },
          },
          required: ['question'],
        },
        context: {
          type: 'object',
          properties: {
            question: { type: 'string' },
            answer: { type: 'string' },
          },
          required: ['question'],
        },
        output: {
          type: 'object',
          properties: {
            answer: { type: 'string' },
          },
          required: ['answer'],
        },
      },
      context: {
        question: '{{ input.question }}',
      },
      requests: {
        answerQuestion: {
          model: 'test-model',
          prompt: 'Question: {{ input.question }}',
          input: {
            type: 'object',
            properties: {
              question: { type: 'string' },
            },
            required: ['question'],
          },
          output: {
            type: 'object',
            properties: {
              answer: { type: 'string' },
            },
            required: ['answer'],
          },
        },
      },
      initial: 'answering',
      states: {
        answering: {
          invoke: {
            id: 'answer',
            src: 'answerQuestion',
            input: {
              question: '{{ context.question }}',
            },
            onDone: {
              target: 'done',
              assign: {
                answer: '{{ event.output.answer }}',
              },
            },
          },
        },
        done: {
          type: 'final',
          output: {
            answer: '{{ context.answer }}',
          },
        },
      },
    });

    let step = initialAgentStep(machine, { question: 'Why statecharts?' });

    expect(step.requests).toEqual([
      expect.objectContaining({
        id: 'answer',
        src: 'answerQuestion',
        input: expect.objectContaining({
          model: 'test-model',
          prompt: 'Question: Why statecharts?',
        }),
      }),
    ]);
    expect(step.requests[0]!.input.outputSchema?.['~standard'].jsonSchema?.input?.())
      .toEqual(expect.objectContaining({ type: 'object' }));

    await expect(
      executeAgentRequest(step.requests[0]!, {
        generateText: async () => ({
          output: { answer: 42 },
        }),
      })
    ).rejects.toThrow();

    const output = await executeAgentRequest(step.requests[0]!, {
      generateText: async () => ({
        output: { answer: 'Because logic matters.' },
      }),
    });
    step = resolveAgentStep(machine, step, step.requests[0]!, output);

    expect(step.done).toBe(true);
    expect(step.snapshot.output).toEqual({ answer: 'Because logic matters.' });
  });

  test('agent.userInput is a blessed host-provided actor for static workflows', async () => {
    const machine = setupAgent
      .fromConfig({
        id: 'static-user-input',
        schemas: {
          input: {
            type: 'object',
            properties: {},
          },
          context: {
            type: 'object',
            properties: {
              recipient: { type: 'string' },
              draft: { type: 'string' },
            },
          },
          output: {
            type: 'object',
            properties: {
              draft: { type: 'string' },
            },
            required: ['draft'],
          },
        },
        context: {},
        requests: {
          draftEmail: {
            model: 'writer',
            prompt: 'Draft email to {{ input.recipient }}',
            input: {
              type: 'object',
              properties: {
                recipient: { type: 'string' },
              },
              required: ['recipient'],
            },
            output: {
              type: 'object',
              properties: {
                draft: { type: 'string' },
              },
              required: ['draft'],
            },
          },
        },
        initial: 'askRecipient',
        states: {
          askRecipient: {
            invoke: {
              id: 'recipient',
              src: 'agent.userInput',
              input: {
                prompt: 'Who should receive this email?',
                schema: {
                  type: 'object',
                  properties: {
                    recipient: { type: 'string' },
                  },
                  required: ['recipient'],
                },
              },
              onDone: {
                target: 'draftEmail',
                assign: {
                  recipient: '{{ event.output.recipient }}',
                },
              },
            },
          },
          draftEmail: {
            invoke: {
              id: 'draft',
              src: 'draftEmail',
              input: {
                recipient: '{{ context.recipient }}',
              },
              onDone: {
                target: 'done',
                assign: {
                  draft: '{{ event.output.draft }}',
                },
              },
            },
          },
          done: {
            type: 'final',
            output: {
              draft: '{{ context.draft }}',
            },
          },
        },
      })
      .provide({
        actorSources: {
          'agent.userInput': createAsyncLogic({
            run: async ({ input }) => {
              expect(input).toEqual(
                expect.objectContaining({
                  prompt: 'Who should receive this email?',
                  schema: expect.objectContaining({ type: 'object' }),
                }),
              );
              return { recipient: 'Ada' };
            },
          }),
          draftEmail: createAsyncLogic({
            run: async ({ input }) => {
              expect(input).toEqual({ recipient: 'Ada' });
              return { draft: 'Hello Ada.' };
            },
          }),
        },
      });

    const actor = createActor(machine, { input: {} }).start();
    await waitFor(actor, (snapshot) => snapshot.status === 'done');

    expect(actor.getSnapshot().output).toEqual({ draft: 'Hello Ada.' });
  });
});
