import { z } from 'zod';
import { setup } from 'xstate';
import { createAgentSchemas, createTextLogic, runAgent } from '../../src/index.js';
import { createAiSdkTextExecutor } from '../ai-sdk-host/index.js';

const classificationSchema = z.object({
  reasoning: z.string(),
  type: z.enum(['general', 'refund', 'technical']),
  complexity: z.enum(['simple', 'complex']),
});

export const classifyCustomerQuery = createTextLogic({
  schemas: {
    input: z.object({ query: z.string() }),
    output: classificationSchema,
  },
  model: 'openai/gpt-4.1-mini',
  prompt: ({ input }) => `Classify this customer query:\n${input.query}`,
});

export const answerCustomerQuery = createTextLogic({
  schemas: {
    input: z.object({
      query: z.string(),
      classification: classificationSchema,
    }),
    output: z.string(),
  },
  model: ({ input }) =>
    input.classification.complexity === 'simple'
      ? 'openai/gpt-4o-mini'
      : 'openai/o4-mini',
  system: ({ input }) => ({
    general: 'You handle general customer inquiries.',
    refund: 'You specialize in refund requests.',
    technical: 'You provide technical troubleshooting.',
  })[input.classification.type],
  prompt: ({ input }) => input.query,
});

const agent = setup({
  schemas: createAgentSchemas({
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
  }),
  actorSources: { classifyCustomerQuery, answerCustomerQuery },
});

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
  return await runAgent(aiSdkRoutingMachine, {
    input: { query: 'The app crashes on launch.' },
    generateText: createAiSdkTextExecutor(),
  });
}

if (import.meta.url === new URL(process.argv[1]!, 'file:').href) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('Set OPENAI_API_KEY to run this example.');
  }
  console.log(await runAiSdkRoutingExample());
}
