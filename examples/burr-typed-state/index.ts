import assert from 'node:assert/strict';
import { z } from 'zod';
import { createActor, createAsyncLogic, toPromise, waitFor } from 'xstate';
import { setupAgent } from '../../src/index.js';

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

  const post = actor.getSnapshot().output?.post;
  assert.equal(post?.topic, 'Burr');
  assert.deepEqual(post?.concepts, [
    { term: 'state', definition: 'durable memory', timestamp: 1 },
  ]);
}

if (import.meta.url === new URL(process.argv[1]!, 'file:').href) {
  await runBurrTypedStateExample();
}
