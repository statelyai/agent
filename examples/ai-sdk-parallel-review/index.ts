/**
 * Vercel AI SDK parallel review — parallel processing, ported to `setupAgent`
 * with co-located `requests:`. Three per-aspect reviews (security,
 * performance, maintainability) each run as their own model call, fanned out
 * concurrently via a `type: 'parallel'` region, then a fourth request
 * summarizes them — matching the source example, where each aspect is an
 * independent `generateText`/`Output.object` call run under `Promise.all`.
 *
 * Compare: https://ai-sdk.dev/docs/agents/workflows#parallel-processing
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/ai-sdk-parallel-review/index.ts
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
type Review = z.infer<typeof reviewSchema>;

// Per-aspect review output (the model returns findings + severity; the fixed
// `type` tag is stamped on in `onDone` so the schema the model fills is small).
const aspectReviewSchema = z.object({
  findings: z.array(z.string()),
  severity: z.enum(['low', 'medium', 'high']),
});

export const models: Record<
  'securityReviewer' | 'performanceReviewer' | 'maintainabilityReviewer' | 'summarizer',
  LanguageModel
> = {
  securityReviewer: openai('gpt-5.4-mini'),
  performanceReviewer: openai('gpt-5.4-mini'),
  maintainabilityReviewer: openai('gpt-5.4-mini'),
  summarizer: openai('gpt-5.4-mini'),
} as const;

const codeInput = z.object({ code: z.string() });

const agent = setupAgent({
  models,
  context: z.object({
    code: z.string(),
    security: reviewSchema.nullable(),
    performance: reviewSchema.nullable(),
    maintainability: reviewSchema.nullable(),
    summary: z.string().nullable(),
  }),
  input: codeInput,
  output: z.object({
    reviews: z.array(reviewSchema),
    summary: z.string(),
  }),
  requests: {
    reviewSecurity: {
      schemas: { input: codeInput, output: aspectReviewSchema },
      model: 'securityReviewer',
      system:
        'You are a security reviewer. Identify injection, auth, secret-handling, and unsafe-eval risks. List concrete findings and rate overall severity.',
      prompt: ({ input }) => `Review this code for security issues:\n${input.code}`,
    },
    reviewPerformance: {
      schemas: { input: codeInput, output: aspectReviewSchema },
      model: 'performanceReviewer',
      system:
        'You are a performance reviewer. Identify hot-path allocations, redundant work, and complexity issues. List concrete findings and rate overall severity.',
      prompt: ({ input }) => `Review this code for performance issues:\n${input.code}`,
    },
    reviewMaintainability: {
      schemas: { input: codeInput, output: aspectReviewSchema },
      model: 'maintainabilityReviewer',
      system:
        'You are a maintainability reviewer. Identify naming, structure, and readability problems. List concrete findings and rate overall severity.',
      prompt: ({ input }) => `Review this code for maintainability issues:\n${input.code}`,
    },
    summarizeCodeReviews: {
      schemas: {
        input: z.object({ reviews: z.array(reviewSchema) }),
        output: z.string(),
      },
      model: 'summarizer',
      system: 'Summarize multiple per-aspect code reviews into the key actions to take, highest severity first.',
      prompt: ({ input }) => JSON.stringify(input.reviews, null, 2),
    },
  },
});

export const reviewSecurity = agent.requests.reviewSecurity;
export const reviewPerformance = agent.requests.reviewPerformance;
export const reviewMaintainability = agent.requests.reviewMaintainability;
export const summarizeCodeReviews = agent.requests.summarizeCodeReviews;

function collectReviews(context: {
  security: Review | null;
  performance: Review | null;
  maintainability: Review | null;
}): Review[] {
  return [context.security, context.performance, context.maintainability].filter(
    (review): review is Review => review !== null,
  );
}

export const aiSdkParallelReviewMachine = agent.createMachine({
  id: 'ai-sdk-parallel-review',
  context: ({ input }) => ({
    code: input.code,
    security: null,
    performance: null,
    maintainability: null,
    summary: null,
  }),
  output: ({ context }) => ({
    reviews: collectReviews(context),
    summary: context.summary ?? '',
  }),
  initial: 'reviewing',
  states: {
    // The three aspect reviews are independent model calls; `type: 'parallel'`
    // runs them concurrently and only leaves `reviewing` once all three land.
    reviewing: {
      type: 'parallel',
      onDone: { target: 'summarizing' },
      states: {
        security: {
          initial: 'active',
          states: {
            active: {
              invoke: {
                id: 'reviewSecurity',
                src: 'reviewSecurity',
                input: ({ context }) => ({ code: context.code }),
                onDone: ({ output }) => ({
                  target: 'done',
                  context: {
                    security: { type: 'security' as const, ...output },
                  },
                }),
              },
            },
            done: { type: 'final' },
          },
        },
        performance: {
          initial: 'active',
          states: {
            active: {
              invoke: {
                id: 'reviewPerformance',
                src: 'reviewPerformance',
                input: ({ context }) => ({ code: context.code }),
                onDone: ({ output }) => ({
                  target: 'done',
                  context: {
                    performance: { type: 'performance' as const, ...output },
                  },
                }),
              },
            },
            done: { type: 'final' },
          },
        },
        maintainability: {
          initial: 'active',
          states: {
            active: {
              invoke: {
                id: 'reviewMaintainability',
                src: 'reviewMaintainability',
                input: ({ context }) => ({ code: context.code }),
                onDone: ({ output }) => ({
                  target: 'done',
                  context: {
                    maintainability: { type: 'maintainability' as const, ...output },
                  },
                }),
              },
            },
            done: { type: 'final' },
          },
        },
      },
    },
    summarizing: {
      invoke: {
        id: 'summarizeCodeReviews',
        src: 'summarizeCodeReviews',
        input: ({ context }) => ({ reviews: collectReviews(context) }),
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
    console.error('Set OPENAI_API_KEY to run this example.');
    process.exit(1);
  }
  console.log(await runAiSdkParallelReviewExample());
}
