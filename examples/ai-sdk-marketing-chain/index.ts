/**
 * Vercel AI SDK marketing chain — sequential processing, ported to
 * `setupAgent` with co-located `requests:`.
 *
 * Compare: https://ai-sdk.dev/docs/agents/workflows#sequential-processing-chains
 *
 * Run: OPENAI_API_KEY=... node --import tsx examples/ai-sdk-marketing-chain/index.ts
 */
import { z } from 'zod';
import { setupAgent, runAgent } from '../../src/index.js';
import { createAiSdkTextExecutor } from '../ai-sdk-host/index.js';

const qualitySchema = z.object({
  hasCallToAction: z.boolean(),
  emotionalAppeal: z.number().min(1).max(10),
  clarity: z.number().min(1).max(10),
});

function qualityPasses(quality: z.infer<typeof qualitySchema> | null) {
  return !!quality
    && quality.hasCallToAction
    && quality.emotionalAppeal >= 7
    && quality.clarity >= 7;
}

const agent = setupAgent({
  context: z.object({
    product: z.string(),
    copy: z.string().nullable(),
    quality: qualitySchema.nullable(),
    finalCopy: z.string().nullable(),
  }),
  input: z.object({ product: z.string() }),
  output: z.object({ copy: z.string(), quality: qualitySchema }),
  requests: {
    writeMarketingCopy: {
      schemas: {
        input: z.object({ product: z.string() }),
        output: z.string(),
      },
      model: 'openai/gpt-4.1-mini',
      prompt: ({ input }) =>
        `Write persuasive marketing copy for: ${input.product}. Focus on benefits and emotional appeal.`,
    },
    evaluateMarketingCopy: {
      schemas: {
        input: z.object({ copy: z.string() }),
        output: qualitySchema,
      },
      model: 'openai/gpt-4.1-mini',
      system: 'Evaluate marketing copy for CTA, emotional appeal, and clarity.',
      prompt: ({ input }) => input.copy,
    },
    improveMarketingCopy: {
      schemas: {
        input: z.object({ copy: z.string(), quality: qualitySchema }),
        output: z.string(),
      },
      model: 'openai/gpt-4.1-mini',
      prompt: ({ input }) => [
        !input.quality.hasCallToAction ? 'Add a clear call to action.' : '',
        input.quality.emotionalAppeal < 7 ? 'Strengthen emotional appeal.' : '',
        input.quality.clarity < 7 ? 'Improve clarity and directness.' : '',
        `Original copy: ${input.copy}`,
      ].filter(Boolean).join('\n'),
    },
  },
});

export const writeMarketingCopy = agent.requests.writeMarketingCopy;
export const evaluateMarketingCopy = agent.requests.evaluateMarketingCopy;
export const improveMarketingCopy = agent.requests.improveMarketingCopy;

export const aiSdkMarketingChainMachine = agent.createMachine({
  id: 'ai-sdk-marketing-chain',
  context: ({ input }) => ({
    product: input.product,
    copy: null,
    quality: null,
    finalCopy: null,
  }),
  output: ({ context }) => ({
    copy: context.finalCopy ?? context.copy ?? '',
    quality: context.quality ?? {
      hasCallToAction: false,
      emotionalAppeal: 0,
      clarity: 0,
    },
  }),
  initial: 'writing',
  states: {
    writing: {
      invoke: {
        id: 'writeMarketingCopy',
        src: 'writeMarketingCopy',
        input: ({ context }) => ({ product: context.product }),
        onDone: ({ output }) => ({
          target: 'evaluating',
          context: { copy: output },
        }),
      },
    },
    evaluating: {
      invoke: {
        id: 'evaluateMarketingCopy',
        src: 'evaluateMarketingCopy',
        input: ({ context }) => ({ copy: context.copy ?? '' }),
        onDone: ({ output }) => ({
          target: 'checking',
          context: { quality: output },
        }),
      },
    },
    checking: {
      always: ({ context }) =>
        qualityPasses(context.quality)
          ? { target: 'done' }
          : { target: 'improving' },
    },
    improving: {
      invoke: {
        id: 'improveMarketingCopy',
        src: 'improveMarketingCopy',
        input: ({ context }) => ({
          copy: context.copy ?? '',
          quality: context.quality ?? {
            hasCallToAction: false,
            emotionalAppeal: 0,
            clarity: 0,
          },
        }),
        onDone: ({ output }) => ({
          target: 'done',
          context: { finalCopy: output },
        }),
      },
    },
    done: { type: 'final' },
  },
});

export async function runAiSdkMarketingChainExample() {
  const result = await runAgent(aiSdkMarketingChainMachine, {
    input: { product: 'state machines' },
    generateText: createAiSdkTextExecutor(),
  });
  if (result.status !== 'done') {
    throw new Error(`Marketing chain example did not complete: ${result.status}`);
  }
  return result.output;
}

if (import.meta.url === new URL(process.argv[1]!, 'file:').href) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('Set OPENAI_API_KEY to run this example.');
  }
  console.log(await runAiSdkMarketingChainExample());
}
