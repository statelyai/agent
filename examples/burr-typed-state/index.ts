/**
 * Burr Typed State — schema-derived structured output, hosted with runAgent.
 *
 * Burr's `typed-state` example validates that action outputs conform to a
 * declared state schema. Here the schema lives once, on `setupAgent`'s
 * `context`/`requests.generatePost.schemas.output`, and both the machine
 * context and the model's structured output are derived from it — no
 * separate runtime validation step.
 */
import assert from 'node:assert/strict';
import { z } from 'zod';
import { createAsyncLogic } from 'xstate';
import { runAgent, setupAgent, type AgentTextRequest, type AgentTools } from '../../src/index.js';

export async function runBurrTypedStateExample() {
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
  const agent = setupAgent({
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

  const generateText = async (request: AgentTextRequest & { tools: AgentTools }) => ({
    object: {
      topic: 'Burr',
      hook: 'Stateful AI apps need structure.',
      body: request.prompt ?? '',
      concepts: [
        { term: 'state', definition: 'durable memory', timestamp: 1 },
      ],
      keyTakeaways: ['Keep state explicit'],
    },
  });

  const result = await runAgent(machine, {
    input: { youtubeUrl: 'https://youtube.test/watch?v=abc' },
    generateText,
  });

  if (result.status !== 'done') {
    throw new Error(`Typed-state example did not complete: ${result.status}`);
  }
  assert.equal(result.output.post.topic, 'Burr');
  assert.deepEqual(result.output.post.concepts, [
    { term: 'state', definition: 'durable memory', timestamp: 1 },
  ]);
}

if (import.meta.url === new URL(process.argv[1]!, 'file:').href) {
  await runBurrTypedStateExample();
}
