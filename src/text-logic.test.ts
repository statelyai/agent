import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { createActor, toPromise } from 'xstate';
import {
  createAgentSchemas,
  createTextLogic,
  runAgent,
  setupAgent,
  type AgentRequest,
  type AgentTextRequest,
  type AgentTools,
} from './index.js';
import {
  executeAgentTextRequest,
  type AgentRequestExecutorInfo,
} from './text-logic.js';

// Focused coverage for the `mode: 'stream'` path of `createTextLogic`:
// the `onChunk` seam, streamText-missing errors, structured-output behavior,
// interleaved parallel streams, and `.withExecutor(...)` on a stream logic.
// The happy-path request lowering / `.execute()` dispatch is already covered
// in setup-agent.test.ts and run-agent.test.ts.
describe('createTextLogic({ mode: "stream" })', () => {
  const streamJoke = createTextLogic({
    mode: 'stream',
    schemas: { input: z.object({ topic: z.string() }), output: z.string() },
    model: 'test-model',
    prompt: ({ input }) => `Joke about ${input.topic}.`,
  });

  test('runAgent delivers chunks in order and assembles the full text via onChunk', async () => {
    const agent = setupAgent({
      schemas: createAgentSchemas({
        context: z.object({ topic: z.string(), joke: z.string().nullable() }),
        input: z.object({ topic: z.string() }),
        output: z.object({ joke: z.string() }),
      }),
      actorSources: { streamJoke },
    });
    const machine = agent.createMachine({
      context: ({ input }) => ({ topic: input.topic, joke: null }),
      initial: 'streaming',
      states: {
        streaming: {
          invoke: {
            id: 'streamJoke',
            src: 'streamJoke',
            input: ({ context }) => ({ topic: context.topic }),
            onDone: ({ output }) => ({
              target: 'done',
              context: { joke: output as string },
            }),
          },
        },
        done: { type: 'final', output: ({ context }) => ({ joke: context.joke ?? '' }) },
      },
    });

    const chunks: string[] = [];
    const chunkRequests: AgentRequest[] = [];
    const parts = ['Why ', 'did ', 'the ', 'actor ', 'cross?'];

    const result = await runAgent(machine, {
      input: { topic: 'state machines' },
      generateText: async () => {
        throw new Error('generateText should not be used for stream requests');
      },
      streamText: async (
        _request: AgentTextRequest & { tools: AgentTools },
        info?: AgentRequestExecutorInfo,
      ) => {
        for (const part of parts) {
          info?.onChunk?.(part);
        }
        return { output: parts.join('') };
      },
      onChunk: (chunk, info) => {
        chunks.push(chunk);
        chunkRequests.push(info.request);
      },
    });

    // chunk delivery order preserved
    expect(chunks).toEqual(parts);
    // full text assembled from chunks equals the final resolved text
    expect(chunks.join('')).toBe('Why did the actor cross?');
    expect(result.status).toBe('done');
    if (result.status !== 'done') throw new Error('expected done');
    expect(result.output).toEqual({ joke: 'Why did the actor cross?' });

    // onChunk carries the AgentRequest that produced each chunk
    expect(chunkRequests).toHaveLength(parts.length);
    for (const req of chunkRequests) {
      expect(req).toEqual(
        expect.objectContaining({ kind: 'text', id: 'streamJoke', mode: 'stream' }),
      );
    }
  });

  test('runAgent: a stream request with no streamText executor throws', async () => {
    const agent = setupAgent({
      schemas: createAgentSchemas({
        context: z.object({ topic: z.string() }),
        input: z.object({ topic: z.string() }),
      }),
      actorSources: { streamJoke },
    });
    const machine = agent.createMachine({
      context: ({ input }) => ({ topic: input.topic }),
      initial: 'streaming',
      states: {
        streaming: {
          invoke: { id: 'streamJoke', src: 'streamJoke', input: ({ context }) => ({ topic: context.topic }) },
        },
      },
    });

    await expect(
      runAgent(machine, {
        input: { topic: 'x' },
        generateText: async () => ({ output: 'nope' }),
      }),
    ).rejects.toThrow(/streamText/);
  });

  test('executeAgentTextRequest: stream mode with no streamText executor throws naming the id', async () => {
    await expect(
      executeAgentTextRequest(
        'stream',
        'myStream',
        { model: 'test-model' },
        { generateText: async () => ({ output: 'nope' }) },
      ),
    ).rejects.toThrow(/no executor.*stream.*'myStream'/i);
  });

  test('executeAgentTextRequest: stream mode passes info (onChunk/signal) through to streamText', async () => {
    const seen: string[] = [];
    let sawSignal = false;
    const controller = new AbortController();

    const { output } = await executeAgentTextRequest(
      'stream',
      'myStream',
      { model: 'test-model', prompt: 'go' },
      {
        generateText: async () => {
          throw new Error('generateText should not be used');
        },
        streamText: async (_request, info) => {
          info?.onChunk?.('a');
          info?.onChunk?.('b');
          sawSignal = info?.signal === controller.signal;
          return { output: 'ab' };
        },
      },
      {},
      { onChunk: (c) => seen.push(c), signal: controller.signal },
    );

    expect(seen).toEqual(['a', 'b']);
    expect(sawSignal).toBe(true);
    expect(output).toBe('ab');
  });

  test('stream mode with a structured (object) output schema validates and returns the object', async () => {
    const streamStructured = createTextLogic({
      mode: 'stream',
      schemas: {
        input: z.object({ topic: z.string() }),
        output: z.object({ setup: z.string(), punchline: z.string() }),
      },
      model: 'test-model',
      prompt: ({ input }) => input.topic,
    });

    // the lowered request still carries the structured output schema
    expect(streamStructured.request({ topic: 'x' }).outputSchema).toBe(
      streamStructured.schemas.output,
    );

    // streamText returning an { object } result is normalized + schema-validated
    await expect(
      streamStructured.execute(
        { topic: 'actors' },
        {
          generateText: async () => {
            throw new Error('generateText should not be used');
          },
          streamText: async () => ({
            output: { setup: 'Knock knock.', punchline: 'XState.' },
          }),
        },
      ),
    ).resolves.toEqual({ setup: 'Knock knock.', punchline: 'XState.' });

    // output failing the schema surfaces as a validation error
    await expect(
      streamStructured.execute(
        { topic: 'actors' },
        {
          generateText: async () => ({ output: {} }),
          streamText: async () => ({ output: { setup: 'only setup' } }),
        },
      ),
    ).rejects.toThrow();
  });

  test('.withExecutor(...) on a stream logic runs as an actor and streams via emit-free executor', async () => {
    const bound = streamJoke.withExecutor(async ({ input, request }) => {
      expect(request.model).toBe('test-model');
      expect(request.prompt).toBe(`Joke about ${input.topic}.`);
      return { output: `bound joke about ${input.topic}` };
    });

    // still a stream logic
    expect(bound.mode).toBe('stream');

    const actor = createActor(bound, { input: { topic: 'reducers' } });
    actor.start();
    await expect(toPromise(actor)).resolves.toBe('bound joke about reducers');
  });

  test('parallel stream requests interleave: onChunk disambiguates by request id', async () => {
    const streamA = createTextLogic({
      mode: 'stream',
      schemas: { input: z.object({}), output: z.string() },
      model: 'test-model',
      prompt: () => 'a',
    });
    const streamB = createTextLogic({
      mode: 'stream',
      schemas: { input: z.object({}), output: z.string() },
      model: 'test-model',
      prompt: () => 'b',
    });

    const agent = setupAgent({
      schemas: createAgentSchemas({
        context: z.object({ a: z.string().nullable(), b: z.string().nullable() }),
        input: z.object({}),
        output: z.object({ a: z.string(), b: z.string() }),
      }),
      actorSources: { streamA, streamB },
    });

    const machine = agent.createMachine({
      context: { a: null, b: null },
      type: 'parallel',
      output: ({ context }) => ({ a: context.a ?? '', b: context.b ?? '' }),
      states: {
        left: {
          initial: 'streaming',
          states: {
            streaming: {
              invoke: {
                id: 'streamA',
                src: 'streamA',
                input: {},
                onDone: ({ output }) => ({ target: 'done', context: { a: output as string } }),
              },
            },
            done: { type: 'final' },
          },
        },
        right: {
          initial: 'streaming',
          states: {
            streaming: {
              invoke: {
                id: 'streamB',
                src: 'streamB',
                input: {},
                onDone: ({ output }) => ({ target: 'done', context: { b: output as string } }),
              },
            },
            done: { type: 'final' },
          },
        },
      },
    });

    const chunksById: Record<string, string[]> = { streamA: [], streamB: [] };

    const result = await runAgent(machine, {
      input: {},
      generateText: async () => {
        throw new Error('generateText should not be used');
      },
      streamText: async (request, info) => {
        // emit two chunks tagged with which stream produced them
        const tag = request.prompt === 'a' ? 'A' : 'B';
        info?.onChunk?.(tag);
        info?.onChunk?.(tag);
        return { output: `${tag}${tag}` };
      },
      // even if streams interleave, info.request.id tells them apart
      onChunk: (chunk, info) => {
        if (info.request.kind === 'text') {
          chunksById[info.request.id]?.push(chunk);
        }
      },
    });

    expect(result.status).toBe('done');
    if (result.status !== 'done') throw new Error('expected done');
    // each stream resolved to its own tagged text
    expect(result.output).toEqual({ a: 'AA', b: 'BB' });
    // chunks are disambiguated by request id even though both streams ran
    expect(chunksById.streamA).toEqual(['A', 'A']);
    expect(chunksById.streamB).toEqual(['B', 'B']);
  });
});
