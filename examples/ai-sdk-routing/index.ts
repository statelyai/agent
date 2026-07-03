/**
 * Vercel AI SDK routing — ported to `setupAgent` with co-located
 * `requests:`. `answerCustomerQuery` picks its model/system per
 * classification, showcasing per-call model/system as functions of input.
 *
 * Compare: https://ai-sdk.dev/docs/agents/workflows#routing
 *
 * Run: OPENAI_API_KEY=... node --import tsx examples/ai-sdk-routing/index.ts
 */
import { z } from 'zod';
import { openai } from '@ai-sdk/openai';
import { setupAgent, runAgent } from '../../src/index.js';
import { createAiSdkTextExecutor } from '../ai-sdk-host/index.js';
import { type LanguageModel } from 'ai';

const classificationSchema = z.object({
  reasoning: z.string(),
  type: z.enum(['general', 'refund', 'technical']),
  complexity: z.enum(['simple', 'complex']),
});

export const models: Record<'classifier' | 'simpleAnswerer' | 'complexAnswerer', LanguageModel> = {
  classifier: openai('gpt-4.1-mini'),
  simpleAnswerer: openai('gpt-4o-mini'),
  complexAnswerer: openai('o4-mini'),
} as const;

const agent = setupAgent({
  models,
  context: z.object({
    query: z.string(),
    classification: classificationSchema.nullable(),
    response: z.string().nullable(),
  }),
  input: z.object({ query: z.string() }),
  output: z.object({
    classification: classificationSchema,
    response: z.string(),
  }),
  requests: {
    classifyCustomerQuery: {
      schemas: {
        input: z.object({ query: z.string() }),
        output: classificationSchema,
      },
      model: 'classifier',
      prompt: ({ input }) => `Classify this customer query:\n${input.query}`,
    },
    answerCustomerQuery: {
      schemas: {
        input: z.object({
          query: z.string(),
          classification: classificationSchema,
        }),
        output: z.string(),
      },
      model: ({ input }) =>
        input.classification.complexity === 'simple'
          ? 'simpleAnswerer'
          : 'complexAnswerer',
      system: ({ input }) => ({
        general: 'You handle general customer inquiries.',
        refund: 'You specialize in refund requests.',
        technical: 'You provide technical troubleshooting.',
      })[input.classification.type],
      prompt: ({ input }) => input.query,
    },
  },
});

export const classifyCustomerQuery = agent.requests.classifyCustomerQuery;
export const answerCustomerQuery = agent.requests.answerCustomerQuery;

export const aiSdkRoutingMachine = agent.createMachine({
  id: 'ai-sdk-routing',
  context: ({ input }) => ({
    query: input.query,
    classification: null,
    response: null,
  }),
  output: ({ context }) => ({
    classification: context.classification ?? {
      reasoning: '',
      type: 'general',
      complexity: 'simple',
    },
    response: context.response ?? '',
  }),
  initial: 'classifying',
  states: {
    classifying: {
      invoke: {
        id: 'classifyCustomerQuery',
        src: 'classifyCustomerQuery',
        input: ({ context }) => ({ query: context.query }),
        onDone: ({ output }) => ({
          target: 'responding',
          context: { classification: output },
        }),
      },
    },
    responding: {
      invoke: {
        id: 'answerCustomerQuery',
        src: 'answerCustomerQuery',
        input: ({ context }) => ({
          query: context.query,
          classification: context.classification ?? {
            reasoning: '',
            type: 'general',
            complexity: 'simple',
          },
        }),
        onDone: ({ output }) => ({
          target: 'done',
          context: { response: output },
        }),
      },
    },
    done: { type: 'final' },
  },
});

export async function runAiSdkRoutingExample() {
  const result = await runAgent(aiSdkRoutingMachine, {
    input: { query: 'The app crashes on launch.' },
    generateText: createAiSdkTextExecutor({ models }),
  });
  if (result.status !== 'done') {
    throw new Error(`Routing example did not complete: ${result.status}`);
  }
  return result.output;
}

if (import.meta.url === new URL(process.argv[1]!, 'file:').href) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('Set OPENAI_API_KEY to run this example.');
  }
  console.log(await runAiSdkRoutingExample());
}
