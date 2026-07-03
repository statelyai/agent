/**
 * Vercel AI SDK parallel review — ported to `setupAgent` with a co-located
 * `requests:` entry for the summarize step. The three per-aspect reviews
 * are deterministic (no model call) in the source AI SDK example, so they
 * stay as a pure `always` transition rather than becoming request calls.
 *
 * Compare: https://ai-sdk.dev/docs/agents/workflows#parallel-processing
 *
 * Run: OPENAI_API_KEY=... node --import tsx examples/ai-sdk-parallel-review/index.ts
 */
import { z } from 'zod';
import { openai } from '@ai-sdk/openai';
import { setupAgent, runAgent } from '../../src/index.js';
import { createAiSdkTextExecutor } from '../ai-sdk-host/index.js';
import { type LanguageModel } from 'ai';

const reviewSchema = z.object({
  type: z.enum(['security', 'performance', 'maintainability']),
  findings: z.array(z.string()),
  severity: z.enum(['low', 'medium', 'high']),
});

function createCodeReviews(code: string): Array<z.infer<typeof reviewSchema>> {
  return [
    {
      type: 'security',
      findings: [`security:${code.length}`],
      severity: 'low',
    },
    {
      type: 'performance',
      findings: [`performance:${code.length}`],
      severity: 'medium',
    },
    {
      type: 'maintainability',
      findings: [`maintainability:${code.length}`],
      severity: 'low',
    },
  ];
}

export const models: Record<'summarizer', LanguageModel> = {
  summarizer: openai('gpt-4.1-mini'),
} as const;

const agent = setupAgent({
  models,
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
  requests: {
    summarizeCodeReviews: {
      schemas: {
        input: z.object({ reviews: z.array(reviewSchema) }),
        output: z.string(),
      },
      model: 'summarizer',
      system: 'Summarize multiple code reviews into key actions.',
      prompt: ({ input }) => JSON.stringify(input.reviews, null, 2),
    },
  },
});

export const summarizeCodeReviews = agent.requests.summarizeCodeReviews;

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
      always: ({ context }) => ({
        target: 'summarizing',
        context: { reviews: createCodeReviews(context.code) },
      }),
    },
    summarizing: {
      invoke: {
        id: 'summarizeCodeReviews',
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
  const result = await runAgent(aiSdkParallelReviewMachine, {
    input: { code: 'const x = eval(input);' },
    generateText: createAiSdkTextExecutor({ models }),
  });
  if (result.status !== 'done') {
    throw new Error(`Parallel review example did not complete: ${result.status}`);
  }
  return result.output;
}

if (import.meta.url === new URL(process.argv[1]!, 'file:').href) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('Set OPENAI_API_KEY to run this example.');
  }
  console.log(await runAiSdkParallelReviewExample());
}
