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
  createDecisionLogic,
  createTextLogic,
  DecisionExhaustedError,
  executeAgentRequest,
  getAcceptedEvents,
  getAgentOutputMode,
  getAgentRequests,
  getMachineAgentRequests,
  initialAgentStep,
  isStructuredOutputSchema,
  messagesSchema,
  parseOutput,
  resolveAgentStep,
  resolveDecision,
  runAgent,
  sendDecision,
  setupAgent,
  toolMessage,
  transitionAgentStep,
  transitionResult,
  userMessage,
  type AgentDecisionRequest,
  type AgentRequest,
  type AgentStepRequest,
  type AgentTextRequest,
  type AgentTools,
  type ChosenEvent,
  type DecisionAttempt,
} from './index.js';

/** Narrows an `AgentStepRequest` to a text request; fails the test otherwise. */
function asTextRequest(request: AgentStepRequest | undefined): AgentRequest {
  if (request?.kind !== 'text') {
    throw new Error('Expected a text request.');
  }
  return request;
}

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
      }),
    );

    expect(request).toEqual(
      expect.objectContaining({
        mode: 'generate',
        input: expect.objectContaining({ prompt: 'Draft it.' }),
      }),
    );

    expect(getMachineAgentRequests(machine, actions)).toEqual([request]);

    await expect(
      agent.requests.draftEmail.execute(
        { prompt: 'Draft it.' },
        {
          generateText: async (request) => {
            expect(request.prompt).toBe('Draft it.');
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
      executeAgentRequest(asTextRequest(generateTask), {
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
      executeAgentRequest(asTextRequest(streamTask), {
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

    const answer = await executeAgentRequest(asTextRequest(step.requests[0]), {
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

    const streamed = await executeAgentRequest(asTextRequest(step.requests[0]), {
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

  test('executeAgentRequest returns the normalized value by default and { output, raw } when verbose', async () => {
    const schemas = createAgentSchemas({
      context: z.object({ prompt: z.string(), answer: z.string().nullable() }),
      input: z.object({ prompt: z.string() }),
      output: z.object({ answer: z.string() }),
    });
    const answerSchema = z.object({ answer: z.string() });
    const agent = setupAgent({ schemas });
    const machine = agent.createMachine({
      context: ({ input }) => ({ prompt: input.prompt, answer: null }),
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
            }),
            onDone: { target: 'done' },
          },
        },
        done: { type: 'final' },
      },
    });

    const step = initialAgentStep(machine, { prompt: 'Why machines?' });
    const request = asTextRequest(step.requests[0]);
    const rawResult = { object: { answer: 'Because state.' } };

    const defaultResult = await executeAgentRequest(request, {
      generateText: async () => rawResult,
    });
    expect(defaultResult).toEqual({ answer: 'Because state.' });

    const verboseResult = await executeAgentRequest(
      request,
      { generateText: async () => rawResult },
      { verbose: true },
    );
    expect(verboseResult).toEqual({
      output: { answer: 'Because state.' },
      raw: rawResult,
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
      executeAgentRequest(asTextRequest(step.requests[0]), {
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

  test('setupAgent narrows event payloads in `on:` fns even with a co-located invoke', () => {
    // Regression: a state with BOTH `invoke` and `on:` used to widen the
    // transition-fn `event` to `{ type: string }`, so schema-derived payload
    // fields (e.g. `event.n`) were lost. The machine event union collapsed
    // because setupAgent fed xstate's `SetupReturnFromConfig` a
    // `SetupConfig<TSchemas & SetupSchemas>` whose intersected `events` map
    // gained a string index signature, tripping `InferEvents`'
    // `string extends keyof O` branch.
    const schemas = createAgentSchemas({
      context: z.object({ count: z.number() }),
      events: { GO: z.object({ n: z.number() }) },
    });
    const child = createAsyncLogic<number, unknown>({ run: async () => 42 });
    const agent = setupAgent({ schemas, actors: { child } });

    agent.createMachine({
      context: { count: 0 },
      initial: 'a',
      states: {
        a: {
          invoke: {
            id: 'child',
            src: 'child',
            // (c) `onDone` output stays typed from the actor logic.
            onDone: ({ event }) => {
              const output: number = event.output;
              void output;
              return undefined;
            },
          },
          on: {
            GO: ({ event }) => {
              // (a) schema-derived payload narrows.
              const n: number = event.n;
              void n;
              // (b) accessing a field not on the event is a type error.
              // @ts-expect-error `missing` is not part of the GO payload
              void event.missing;
              return undefined;
            },
          },
        },
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
      kind: 'text',
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
      executeAgentRequest(asTextRequest(step.requests[0]), {
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
      kind: 'text',
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

    const output = await executeAgentRequest(asTextRequest(step.requests[0]), {
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

    const runResult = await runAgent(machine, {
      input: { prompt: 'why run agents?' },
      generateText: (request: AgentTextRequest & { tools: AgentTools }) => ({
        object: {
          answer: `Ran: ${request.prompt}`,
        },
      }),
    });
    expect(runResult.status).toBe('done');
    expect(runResult.status === 'done' ? runResult.output : undefined).toEqual({
      answer: 'Ran: why run agents?',
    });
  });

  test('detects structured output schemas separately from validation-only schemas', () => {
    const objectSchema = z.object({ answer: z.string() });
    const stringSchema = z.string();

    expect(getAgentOutputMode(objectSchema)).toBe('structured');
    expect(isStructuredOutputSchema(objectSchema)).toBe(true);
    expect(getAgentOutputMode(stringSchema)).toBe('text');
    expect(isStructuredOutputSchema(stringSchema)).toBe(false);
  });

  test('decision requests expose only allowed events as candidates', async () => {
    const chooseMove = createDecisionLogic({
      schemas: {
        input: z.object({ prompt: z.string() }),
      },
      model: 'test-model',
      prompt: ({ input }) => input.prompt,
      allowedEvents: ['ATTACK', 'DEFEND'],
    });

    const agent = setupAgent({
      context: z.object({ prompt: z.string() }),
      input: z.object({ prompt: z.string() }),
      events: {
        ATTACK: z.object({ target: z.string() }),
        DEFEND: z.object({}),
        PAUSE: z.object({}),
      },
      actors: { chooseMove },
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
            onDone: sendDecision(),
            onError: { target: 'fumbled' },
          },
          on: {
            ATTACK: { target: 'done' },
            DEFEND: { target: 'done' },
            PAUSE: { target: 'paused' },
          },
        },
        paused: {},
        fumbled: {},
        done: { type: 'final' },
      },
    });

    const [snapshot, actions] = initialTransition(machine, {
      prompt: 'Choose the next move.',
    });
    const initialStep = initialAgentStep(machine, { prompt: 'Choose the next move.' });
    const attackStep = transitionAgentStep(machine, initialStep, {
      type: 'ATTACK',
      target: 'goblin',
    });

    expect(attackStep.done).toBe(true);

    expect(
      getAcceptedEvents(snapshot, {
        schemas: agent.schemas,
        eventTypes: ['ATTACK', 'DEFEND', 'HEAL'],
      }),
    ).toEqual([
      expect.objectContaining({ type: 'ATTACK', toolName: 'send_event_ATTACK' }),
      expect.objectContaining({ type: 'DEFEND', toolName: 'send_event_DEFEND' }),
    ]);

    expect(
      getAcceptedEvents(snapshot, {
        schemas: agent.schemas,
        eventTypes: ['ATTACK'],
        eventToolName: ({ eventType }) => `machine_${eventType.toLowerCase()}`,
      }),
    ).toEqual([
      expect.objectContaining({ type: 'ATTACK', toolName: 'machine_attack' }),
    ]);

    const request = getMachineAgentRequests(machine, actions, snapshot)[0];
    if (request?.kind !== 'decision') {
      throw new Error('Expected a decision request.');
    }
    const customNamedRequest = getMachineAgentRequests(machine, actions, snapshot, {
      eventToolName: ({ eventType }: { eventType: string }) =>
        `machine_${eventType.toLowerCase()}`,
    })[0];
    if (customNamedRequest?.kind !== 'decision') {
      throw new Error('Expected a decision request.');
    }

    expect(request.events.map((event) => event.type)).toEqual([
      'ATTACK',
      'DEFEND',
    ]);
    expect(request.events.map((event) => event.toolName)).toEqual([
      'send_event_ATTACK',
      'send_event_DEFEND',
    ]);
    expect(customNamedRequest.events.map((event) => event.toolName)).toEqual([
      'machine_attack',
      'machine_defend',
    ]);

    const chosenEvent = await resolveDecision(request, async () => ({
      event: { type: 'ATTACK', target: 'orc' },
    }));
    expect(chosenEvent).toEqual({ type: 'ATTACK', target: 'orc' });
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
    expect(asTextRequest(step.requests[0]).input.outputSchema?.['~standard'].jsonSchema?.input?.())
      .toEqual(expect.objectContaining({ type: 'object' }));

    await expect(
      executeAgentRequest(asTextRequest(step.requests[0]), {
        generateText: async () => ({
          output: { answer: 42 },
        }),
      })
    ).rejects.toThrow();

    const output = await executeAgentRequest(asTextRequest(step.requests[0]), {
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

describe('resolveDecision', () => {
  function makeRequest(
    overrides: Partial<AgentDecisionRequest> = {},
  ): AgentDecisionRequest {
    return {
      kind: 'decision',
      id: 'decide',
      model: 'test-model',
      prompt: 'Choose a move.',
      events: [
        { type: 'ATTACK', toolName: 'send_event_ATTACK', inputSchema: z.object({ target: z.string() }) },
        { type: 'DEFEND', toolName: 'send_event_DEFEND' },
      ],
      attempts: [],
      ...overrides,
    };
  }

  test('resolves on the first attempt', async () => {
    const request = makeRequest();
    const event = await resolveDecision(request, async () => ({
      event: { type: 'ATTACK', target: 'goblin' },
    }));

    expect(event).toEqual({ type: 'ATTACK', target: 'goblin' });
  });

  test('retries after an unknown-event failure and reports prior attempts', async () => {
    const request = makeRequest();
    const calls: AgentDecisionRequest[] = [];

    const event = await resolveDecision(
      request,
      async (req) => {
        calls.push(req);
        return calls.length === 1
          ? { event: { type: 'HEAL' } }
          : { event: { type: 'DEFEND' } };
      },
    );

    expect(event).toEqual({ type: 'DEFEND' });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.attempts).toEqual([]);
    expect(calls[1]!.attempts).toHaveLength(1);
    expect(calls[1]!.attempts[0]).toEqual(
      expect.objectContaining({
        event: { type: 'HEAL' },
        failure: 'unknown-event',
      }),
    );
  });

  test('fails with invalid-payload when the event payload fails its inputSchema', async () => {
    const request = makeRequest();

    await expect(
      resolveDecision(
        request,
        async () => ({ event: { type: 'ATTACK' } }), // missing required `target`
        { maxRetries: 0 },
      ),
    ).rejects.toThrow(DecisionExhaustedError);

    try {
      await resolveDecision(
        request,
        async () => ({ event: { type: 'ATTACK' } }),
        { maxRetries: 0 },
      );
      expect.fail('expected DecisionExhaustedError');
    } catch (error) {
      expect(error).toBeInstanceOf(DecisionExhaustedError);
      const attempts = (error as DecisionExhaustedError).attempts;
      expect(attempts).toHaveLength(1);
      expect(attempts[0]!.failure).toBe('invalid-payload');
    }
  });

  test('fails with rejected-by-guard when canTake rejects the event', async () => {
    const request = makeRequest();

    try {
      await resolveDecision(
        request,
        async () => ({ event: { type: 'DEFEND' } }),
        { maxRetries: 0, canTake: () => false },
      );
      expect.fail('expected DecisionExhaustedError');
    } catch (error) {
      expect(error).toBeInstanceOf(DecisionExhaustedError);
      const attempts = (error as DecisionExhaustedError).attempts;
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toEqual(
        expect.objectContaining({
          event: { type: 'DEFEND' },
          failure: 'rejected-by-guard',
        }),
      );
    }
  });

  test('throws DecisionExhaustedError with the full attempts array once the budget is exhausted', async () => {
    const request = makeRequest();

    try {
      await resolveDecision(
        request,
        async () => ({ event: { type: 'UNKNOWN' } }),
        { maxRetries: 2 },
      );
      expect.fail('expected DecisionExhaustedError');
    } catch (error) {
      expect(error).toBeInstanceOf(DecisionExhaustedError);
      const attempts: DecisionAttempt[] = (error as DecisionExhaustedError).attempts;
      expect(attempts).toHaveLength(3);
      expect(attempts.every((attempt) => attempt.failure === 'unknown-event')).toBe(true);
    }
  });
});

describe('decision step discovery', () => {
  const attackSchema = z.object({ target: z.string() });
  const defendSchema = z.object({});

  const decisionSchemas = createAgentSchemas({
    context: z.object({}),
    input: z.object({}),
    events: {
      ATTACK: attackSchema,
      DEFEND: defendSchema,
    },
  });

  function buildMachine() {
    const chooseMove = createDecisionLogic({
      model: 'test-model',
      prompt: 'Choose a move.',
      allowedEvents: ['ATTACK', 'DEFEND'] as const,
    });
    const agent = setupAgent({ schemas: decisionSchemas, actors: { chooseMove } });

    const machine = agent.createMachine({
      context: {},
      initial: 'choosingMove',
      states: {
        choosingMove: {
          invoke: {
            id: 'choosingMove',
            src: 'chooseMove',
            input: {},
            onDone: sendDecision(),
            onError: { target: 'fumbled' },
          },
          on: {
            ATTACK: { target: 'attacked' },
            DEFEND: { target: 'defended' },
          },
        },
        attacked: {},
        defended: {},
        fumbled: {},
      },
    });

    return { agent, machine, chooseMove };
  }

  test('emits an AgentDecisionRequest with machine event schemas intersected in', () => {
    const { machine } = buildMachine();
    const step = initialAgentStep(machine, {}, { schemas: decisionSchemas });

    expect(step.requests).toHaveLength(1);
    const [request] = step.requests;
    expect(request!.kind).toBe('decision');

    const decisionRequest = request as AgentDecisionRequest;
    expect(decisionRequest.id).toBe('choosingMove');
    expect(decisionRequest.attempts).toEqual([]);
    expect(decisionRequest.events.map((event) => event.type).sort()).toEqual([
      'ATTACK',
      'DEFEND',
    ]);
    const attackEvent = decisionRequest.events.find((event) => event.type === 'ATTACK');
    expect(attackEvent?.inputSchema).toBe(attackSchema);
  });

  test('omitted allowedEvents offers every snapshot-legal event', () => {
    const chooseMove = createDecisionLogic({ model: 'test-model' });
    const agent = setupAgent({ schemas: decisionSchemas, actors: { chooseMove } });
    const machine = agent.createMachine({
      context: {},
      initial: 'choosingMove',
      states: {
        choosingMove: {
          invoke: {
            id: 'choosingMove',
            src: 'chooseMove',
            input: {},
            onDone: sendDecision(),
          },
          on: {
            ATTACK: { target: 'attacked' },
            DEFEND: { target: 'defended' },
          },
        },
        attacked: {},
        defended: {},
      },
    });

    const step = initialAgentStep(machine, {}, { schemas: decisionSchemas });
    const decisionRequest = step.requests[0] as AgentDecisionRequest;
    expect(decisionRequest.events.map((event) => event.type).sort()).toEqual([
      'ATTACK',
      'DEFEND',
    ]);
  });
});

describe('decision live path (createActor)', () => {
  const attackSchema = z.object({ target: z.string() });

  const decisionSchemas = createAgentSchemas({
    context: z.object({}),
    input: z.object({}),
    events: {
      ATTACK: attackSchema,
      DEFEND: z.object({}),
    },
  });

  function buildMachine() {
    const chooseMove = createDecisionLogic({
      model: 'test-model',
      allowedEvents: ['ATTACK', 'DEFEND'] as const,
    });
    const agent = setupAgent({ schemas: decisionSchemas, actors: { chooseMove } });

    const machine = agent.createMachine({
      context: {},
      initial: 'choosingMove',
      states: {
        choosingMove: {
          invoke: {
            id: 'choosingMove',
            src: 'chooseMove',
            input: {},
            onDone: sendDecision(),
            onError: { target: 'fumbled' },
          },
          on: {
            ATTACK: { target: 'done-state' },
            DEFEND: { target: 'defended' },
          },
        },
        'done-state': { type: 'final' },
        defended: {},
        fumbled: {},
      },
    });

    return { agent, machine, chooseMove };
  }

  test('delivers the chosen event via sendTo(self) and passes modes 1-2 validation', async () => {
    const { machine, chooseMove } = buildMachine();

    const actor = createActor(
      machine.provide({
        actorSources: {
          chooseMove: chooseMove.withExecutor(async (): Promise<{ event: ChosenEvent }> => ({
            event: { type: 'ATTACK', target: 'goblin' },
          })),
        },
      }),
      { input: {} },
    ).start();

    await waitFor(actor, (snapshot) => snapshot.status === 'done');

    expect(actor.getSnapshot().value).toBe('done-state');
  });

  test('surfaces a DecisionExhaustedError via onError when the executor returns a disallowed event', async () => {
    const { machine, chooseMove } = buildMachine();

    const actor = createActor(
      machine.provide({
        actorSources: {
          chooseMove: chooseMove.withExecutor(async (): Promise<{ event: ChosenEvent }> => ({
            event: { type: 'FLEE' },
          })),
        },
        states: {
          choosingMove: {
            onError: {
              target: 'fumbled',
              actions: ({ event }: { event: { error: unknown } }) => {
                expect(event.error).toBeInstanceOf(DecisionExhaustedError);
              },
            },
          },
        },
      } as never),
      { input: {} },
    ).start();

    await waitFor(actor, (snapshot) => snapshot.matches('fumbled'));

    expect(actor.getSnapshot().value).toBe('fumbled');
  });
});

describe('inline agent.decide invoke (state-local decisions)', () => {
  const attackSchema = z.object({ target: z.string() });

  const decisionSchemas = createAgentSchemas({
    context: z.object({}),
    input: z.object({}),
    events: {
      ATTACK: attackSchema,
      DEFEND: z.object({}),
    },
  });

  function buildMachine() {
    const agent = setupAgent({ schemas: decisionSchemas });

    const machine = agent.createMachine({
      id: 'inline-decision-agent',
      context: {},
      initial: 'choosingMove',
      states: {
        choosingMove: {
          invoke: {
            id: 'choosingMove',
            src: 'agent.decide',
            input: {
              model: 'test-model',
              prompt: 'Choose a move.',
              allowedEvents: ['ATTACK', 'DEFEND'] as const,
            },
            onDone: sendDecision(),
            onError: { target: 'fumbled' },
          },
          on: {
            ATTACK: { target: 'attacked' },
            DEFEND: { target: 'defended' },
          },
        },
        attacked: { type: 'final' },
        defended: {},
        fumbled: {},
      },
    });

    return { agent, machine };
  }

  test('runs to completion through runAgent with a mock decide', async () => {
    const { machine } = buildMachine();

    const result = await runAgent(machine, {
      input: {},
      generateText: async () => ({}),
      decide: async () => ({ event: { type: 'ATTACK', target: 'goblin' } }),
    });

    expect(result.status).toBe('done');
    expect(result.status === 'done' && result.snapshot.value).toBe('attacked');
  });

  test('agent.decide provide()d with a decide executor via createActor delivers the chosen event', async () => {
    const { machine } = buildMachine();

    const actor = createActor(
      machine.provide({
        actorSources: {
          'agent.decide': createAsyncLogic({
            run: async () => ({ type: 'DEFEND' }) as ChosenEvent,
          }),
        },
      } as never),
      { input: {} },
    ).start();

    await waitFor(actor, (snapshot) => snapshot.matches('defended'));

    expect(actor.getSnapshot().value).toBe('defended');
  });

  test('initialAgentStep surfaces the inline agent.decide invoke as kind: decision with intersected events', () => {
    const { machine } = buildMachine();
    const step = initialAgentStep(machine, {}, { schemas: decisionSchemas });

    expect(step.requests).toHaveLength(1);
    const [request] = step.requests;
    expect(request!.kind).toBe('decision');

    const decisionRequest = request as AgentDecisionRequest;
    expect(decisionRequest.id).toBe('choosingMove');
    expect(decisionRequest.events.map((event) => event.type).sort()).toEqual([
      'ATTACK',
      'DEFEND',
    ]);
    const attackEvent = decisionRequest.events.find((event) => event.type === 'ATTACK');
    expect(attackEvent?.inputSchema).toBe(attackSchema);
  });

  test('type probes: inline agent.decide allowedEvents is checked against the machine event-schema keys', () => {
    const agent = setupAgent({ schemas: decisionSchemas });

    // Legal: 'ATTACK' is a declared event.
    agent.createMachine({
      context: {},
      initial: 'choosingMove',
      states: {
        choosingMove: {
          invoke: {
            id: 'choosingMove',
            src: 'agent.decide',
            input: {
              model: 'test-model',
              allowedEvents: ['ATTACK'],
            },
            onDone: sendDecision(),
          },
          on: { ATTACK: { target: 'attacked' } },
        },
        attacked: {},
      },
    });

    // Illegal: typo'd event name.
    agent.createMachine({
      context: {},
      initial: 'choosingMove',
      states: {
        choosingMove: {
          // @ts-expect-error 'ATTAK' is not a declared event (allowedEvents)
          invoke: {
            id: 'choosingMove',
            src: 'agent.decide',
            input: {
              model: 'test-model',
              allowedEvents: ['ATTAK'],
            },
            onDone: sendDecision(),
          },
          on: { ATTACK: { target: 'attacked' } },
        },
        attacked: {},
      },
    });
  });
});
