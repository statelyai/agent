import { z } from 'zod';
import { setup } from 'xstate';
import { createAgentSchemas, createTextLogic, runAgent } from '../../src/index.js';
import { createAiSdkTextExecutor } from '../ai-sdk-host/index.js';

const reviewSchema = z.object({
  type: z.enum(['security', 'performance', 'maintainability']),
  findings: z.array(z.string()),
  severity: z.enum(['low', 'medium', 'high']),
});
const contextSchema = z.object({
  code: z.string(),
  reviews: z.array(reviewSchema),
  summary: z.string().nullable(),
});
type ParallelReviewContext = z.infer<typeof contextSchema>;

export const summarizeCodeReviews = createTextLogic({
  schemas: {
    input: z.object({ reviews: z.array(reviewSchema) }),
    output: z.string(),
  },
  model: 'openai/gpt-4.1-mini',
  system: 'Summarize multiple code reviews into key actions.',
  prompt: ({ input }) => JSON.stringify(input.reviews, null, 2),
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

const agent = setup({
  schemas: createAgentSchemas({
    context: contextSchema,
    input: z.object({ code: z.string() }),
    output: z.object({
      reviews: z.array(reviewSchema),
      summary: z.string(),
    }),
  }),
  actorSources: {
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
      type: 'choice',
      choice: ({ context }: { context: ParallelReviewContext }) => ({
        target: 'summarizing',
        context: { reviews: createCodeReviews(context.code) },
      }),
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
  return await runAgent(aiSdkParallelReviewMachine, {
    input: { code: 'const x = eval(input);' },
    generateText: createAiSdkTextExecutor(),
  });
}

if (import.meta.url === new URL(process.argv[1]!, 'file:').href) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('Set OPENAI_API_KEY to run this example.');
  }
  console.log(await runAiSdkParallelReviewExample());
}
