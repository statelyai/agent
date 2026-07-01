import { z } from 'zod';
import { createActor, setup, toPromise, type AnyActorLogic } from 'xstate';
import { createAgentSchemas, createTextLogic } from '../../src/index.js';
import { createAiSdkTextActor } from '../ai-sdk-host/index.js';

const qualitySchema = z.object({
  hasCallToAction: z.boolean(),
  emotionalAppeal: z.number().min(1).max(10),
  clarity: z.number().min(1).max(10),
});
const contextSchema = z.object({
  product: z.string(),
  copy: z.string().nullable(),
  quality: qualitySchema.nullable(),
  finalCopy: z.string().nullable(),
});
type MarketingChainContext = z.infer<typeof contextSchema>;

function qualityPasses(quality: z.infer<typeof qualitySchema> | null) {
  return !!quality
    && quality.hasCallToAction
    && quality.emotionalAppeal >= 7
    && quality.clarity >= 7;
}

export const writeMarketingCopy = createTextLogic({
  schemas: {
    input: z.object({ product: z.string() }),
    output: z.string(),
  },
  model: 'openai/gpt-4.1-mini',
  prompt: ({ input }) =>
    `Write persuasive marketing copy for: ${input.product}. Focus on benefits and emotional appeal.`,
});

export const evaluateMarketingCopy = createTextLogic({
  schemas: {
    input: z.object({ copy: z.string() }),
    output: qualitySchema,
  },
  model: 'openai/gpt-4.1-mini',
  system: 'Evaluate marketing copy for CTA, emotional appeal, and clarity.',
  prompt: ({ input }) => input.copy,
});

export const improveMarketingCopy = createTextLogic({
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
});

const agent = setup({
  schemas: createAgentSchemas({
    context: contextSchema,
    input: z.object({ product: z.string() }),
    output: z.object({ copy: z.string(), quality: qualitySchema }),
  }),
  actorSources: {
    writeMarketingCopy,
    evaluateMarketingCopy,
    improveMarketingCopy,
  },
});

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
        src: 'evaluateMarketingCopy',
        input: ({ context }) => ({ copy: context.copy ?? '' }),
        onDone: ({ output }) => ({
          target: 'checking',
          context: { quality: output },
        }),
      },
    },
    checking: {
      type: 'choice',
      choice: ({ context }: { context: MarketingChainContext }) =>
        qualityPasses(context.quality)
          ? { target: 'done' }
          : { target: 'improving' },
    },
    improving: {
      invoke: {
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
  const actor = createActor(
    aiSdkMarketingChainMachine.provide({
      actorSources: {
        writeMarketingCopy: createAiSdkTextActor(writeMarketingCopy),
        evaluateMarketingCopy: createAiSdkTextActor(evaluateMarketingCopy),
        improveMarketingCopy: createAiSdkTextActor(improveMarketingCopy),
      },
    }) as unknown as AnyActorLogic,
    { input: { product: 'state machines' } },
  );
  actor.start();
  return await toPromise(actor);
}

if (import.meta.url === new URL(process.argv[1]!, 'file:').href) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('Set OPENAI_API_KEY to run this example.');
  }
  console.log(await runAiSdkMarketingChainExample());
}
