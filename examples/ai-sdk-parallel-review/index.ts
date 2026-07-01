import { z } from 'zod';
import {
  createActor,
  createAsyncLogic,
  setup,
  toPromise,
  type AnyActorLogic,
} from 'xstate';
import { createAgentSchemas, createTextLogic } from '../../src/index.js';
import { createAiSdkTextActor } from '../ai-sdk-host/index.js';

const reviewSchema = z.object({
  type: z.enum(['security', 'performance', 'maintainability']),
  findings: z.array(z.string()),
  severity: z.enum(['low', 'medium', 'high']),
});

export const summarizeCodeReviews = createTextLogic({
  schemas: {
    input: z.object({ reviews: z.array(reviewSchema) }),
    output: z.string(),
  },
  model: 'openai/gpt-4.1-mini',
  system: 'Summarize multiple code reviews into key actions.',
  prompt: ({ input }) => JSON.stringify(input.reviews, null, 2),
});

const agent = setup({
  schemas: createAgentSchemas({
    context: z.object({
      code: z.string(),
      reviews: z.array(reviewSchema),
      summary: z.string().nullable(),
    }),
    input: z.object({ code: z.string() }),
    output: z.object({
      reviews: z.array(reviewSchema),
      summary: z.string(),
    }),
  }),
  actorSources: {
    runParallelReviews: createAsyncLogic<
      z.infer<typeof reviewSchema>[],
      { code: string }
    >({
      run: async ({ input }) =>
        Promise.all([
          {
            type: 'security' as const,
            findings: [`security:${input.code.length}`],
            severity: 'low' as const,
          },
          {
            type: 'performance' as const,
            findings: [`performance:${input.code.length}`],
            severity: 'medium' as const,
          },
          {
            type: 'maintainability' as const,
            findings: [`maintainability:${input.code.length}`],
            severity: 'low' as const,
          },
        ]),
    }),
    summarizeCodeReviews,
  },
});

export const aiSdkParallelReviewMachine = agent.createMachine({
  id: 'ai-sdk-parallel-review',
  context: ({ input }) => ({
    code: input.code,
    reviews: [],
    summary: null,
  }),
  output: ({ context }) => ({
    reviews: context.reviews,
    summary: context.summary ?? '',
  }),
  initial: 'reviewing',
  states: {
    reviewing: {
      invoke: {
        src: 'runParallelReviews',
        input: ({ context }) => ({ code: context.code }),
        onDone: ({ output }) => ({
          target: 'summarizing',
          context: { reviews: output },
        }),
      },
    },
    summarizing: {
      invoke: {
        src: 'summarizeCodeReviews',
        input: ({ context }) => ({ reviews: context.reviews }),
        onDone: ({ output }) => ({
          target: 'done',
          context: { summary: output },
        }),
      },
    },
    done: { type: 'final' },
  },
});

export async function runAiSdkParallelReviewExample() {
  const actor = createActor(
    aiSdkParallelReviewMachine.provide({
      actorSources: {
        summarizeCodeReviews: createAiSdkTextActor(summarizeCodeReviews),
      },
    }) as unknown as AnyActorLogic,
    { input: { code: 'const x = eval(input);' } },
  );
  actor.start();
  return await toPromise(actor);
}

if (import.meta.url === new URL(process.argv[1]!, 'file:').href) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('Set OPENAI_API_KEY to run this example.');
  }
  console.log(await runAiSdkParallelReviewExample());
}
