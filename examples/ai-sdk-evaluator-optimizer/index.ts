/**
 * Vercel AI SDK evaluator-optimizer — ported to `setupAgent` with
 * co-located `requests:`. Keeps the translate → evaluate → (improve →
 * evaluate)* loop, gated by a pure `always` transition that checks quality
 * and iteration budget.
 *
 * Compare: https://ai-sdk.dev/docs/agents/workflows#evaluator-optimizer
 *
 * Run: OPENAI_API_KEY=... node --import tsx examples/ai-sdk-evaluator-optimizer/index.ts
 */
import { z } from 'zod';
import { setupAgent, runAgent } from '../../src/index.js';
import { createAiSdkTextExecutor } from '../ai-sdk-host/index.js';

const translationEvaluationSchema = z.object({
  qualityScore: z.number().min(1).max(10),
  preservesTone: z.boolean(),
  preservesNuance: z.boolean(),
  culturallyAccurate: z.boolean(),
  specificIssues: z.array(z.string()),
  improvementSuggestions: z.array(z.string()),
});

function translationPasses(
  evaluation: z.infer<typeof translationEvaluationSchema> | null,
) {
  return !!evaluation
    && evaluation.qualityScore >= 8
    && evaluation.preservesTone
    && evaluation.preservesNuance
    && evaluation.culturallyAccurate;
}

const agent = setupAgent({
  context: z.object({
    text: z.string(),
    targetLanguage: z.string(),
    translation: z.string().nullable(),
    evaluation: translationEvaluationSchema.nullable(),
    iterations: z.number(),
    maxIterations: z.number(),
  }),
  input: z.object({
    text: z.string(),
    targetLanguage: z.string(),
    maxIterations: z.number().default(3),
  }),
  output: z.object({
    translation: z.string(),
    evaluation: translationEvaluationSchema.nullable(),
    iterations: z.number(),
  }),
  requests: {
    translateText: {
      schemas: {
        input: z.object({ text: z.string(), targetLanguage: z.string() }),
        output: z.string(),
      },
      model: 'openai/gpt-4.1-mini',
      system: 'Translate while preserving tone and cultural nuance.',
      prompt: ({ input }) =>
        `Translate this text to ${input.targetLanguage}:\n${input.text}`,
    },
    evaluateTranslation: {
      schemas: {
        input: z.object({ original: z.string(), translation: z.string() }),
        output: translationEvaluationSchema,
      },
      model: 'openai/gpt-4.1-mini',
      system: 'Evaluate translation quality.',
      prompt: ({ input }) =>
        `Original: ${input.original}\nTranslation: ${input.translation}`,
    },
    improveTranslation: {
      schemas: {
        input: z.object({
          original: z.string(),
          translation: z.string(),
          evaluation: translationEvaluationSchema,
        }),
        output: z.string(),
      },
      model: 'openai/gpt-4.1-mini',
      prompt: ({ input }) => [
        `Original: ${input.original}`,
        `Translation: ${input.translation}`,
        `Issues: ${input.evaluation.specificIssues.join(', ')}`,
        `Suggestions: ${input.evaluation.improvementSuggestions.join(', ')}`,
      ].join('\n'),
    },
  },
});

export const translateText = agent.requests.translateText;
export const evaluateTranslation = agent.requests.evaluateTranslation;
export const improveTranslation = agent.requests.improveTranslation;

export const aiSdkEvaluatorOptimizerMachine = agent.createMachine({
  id: 'ai-sdk-evaluator-optimizer',
  context: ({ input }) => ({
    text: input.text,
    targetLanguage: input.targetLanguage,
    translation: null,
    evaluation: null,
    iterations: 0,
    maxIterations: input.maxIterations,
  }),
  output: ({ context }) => ({
    translation: context.translation ?? '',
    evaluation: context.evaluation,
    iterations: context.iterations,
  }),
  initial: 'translating',
  states: {
    translating: {
      invoke: {
        id: 'translateText',
        src: 'translateText',
        input: ({ context }) => ({
          text: context.text,
          targetLanguage: context.targetLanguage,
        }),
        onDone: ({ output }) => ({
          target: 'evaluating',
          context: { translation: output },
        }),
      },
    },
    evaluating: {
      invoke: {
        id: 'evaluateTranslation',
        src: 'evaluateTranslation',
        input: ({ context }) => ({
          original: context.text,
          translation: context.translation ?? '',
        }),
        onDone: ({ context, output }) => ({
          target: 'checking',
          context: {
            evaluation: output,
            iterations: context.iterations + 1,
          },
        }),
      },
    },
    checking: {
      always: ({ context }) =>
        translationPasses(context.evaluation)
        || context.iterations >= context.maxIterations
          ? { target: 'done' }
          : { target: 'improving' },
    },
    improving: {
      invoke: {
        id: 'improveTranslation',
        src: 'improveTranslation',
        input: ({ context }) => ({
          original: context.text,
          translation: context.translation ?? '',
          evaluation: context.evaluation ?? {
            qualityScore: 0,
            preservesTone: false,
            preservesNuance: false,
            culturallyAccurate: false,
            specificIssues: [],
            improvementSuggestions: [],
          },
        }),
        onDone: ({ output }) => ({
          target: 'evaluating',
          context: { translation: output },
        }),
      },
    },
    done: { type: 'final' },
  },
});

export async function runAiSdkEvaluatorOptimizerExample() {
  const result = await runAgent(aiSdkEvaluatorOptimizerMachine, {
    input: {
      text: 'Hello friend',
      targetLanguage: 'Spanish',
      maxIterations: 3,
    },
    generateText: createAiSdkTextExecutor(),
  });
  if (result.status !== 'done') {
    throw new Error(`Evaluator-optimizer example did not complete: ${result.status}`);
  }
  return result.output;
}

if (import.meta.url === new URL(process.argv[1]!, 'file:').href) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('Set OPENAI_API_KEY to run this example.');
  }
  console.log(await runAiSdkEvaluatorOptimizerExample());
}
