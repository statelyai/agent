/**
 * Vercel AI SDK evaluator-optimizer — ported to `setupAgent` with
 * co-located `requests:`. Keeps the translate → evaluate → (improve →
 * evaluate)* loop, gated by a pure `always` transition that checks quality
 * and iteration budget.
 *
 * Compare: https://ai-sdk.dev/docs/agents/workflows#evaluator-optimizer
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/ai-sdk-evaluator-optimizer/index.ts
 */
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { setupAgent, runAgent } from "../../src/index.js";
import { createAiSdkExecutors, defineModels } from "../../src/ai-sdk/index.js";
import { runExampleMain } from "../helpers/main.js";

const translationEvaluationSchema = z.object({
  qualityScore: z.number().min(1).max(10),
  preservesTone: z.boolean(),
  preservesNuance: z.boolean(),
  culturallyAccurate: z.boolean(),
  specificIssues: z.array(z.string()),
  improvementSuggestions: z.array(z.string()),
});

function translationPasses(evaluation: z.infer<typeof translationEvaluationSchema> | null) {
  return (
    !!evaluation &&
    evaluation.qualityScore >= 8 &&
    evaluation.preservesTone &&
    evaluation.preservesNuance &&
    evaluation.culturallyAccurate
  );
}

export const models = defineModels({
  translator: openai("gpt-5.4-mini"),
  evaluator: openai("gpt-5.4-mini"),
  improver: openai("gpt-5.4-mini"),
});

const contextSchema = z.object({
  text: z.string(),
  targetLanguage: z.string(),
  translation: z.string().nullable(),
  evaluation: translationEvaluationSchema.nullable(),
  iterations: z.number(),
  maxIterations: z.number(),
});

const agentSetup = setupAgent({
  models,
  context: contextSchema,
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
  emitted: {
    TRANSLATED: z.object({ translation: z.string() }),
    EVALUATED: z.object({ qualityScore: z.number(), iteration: z.number() }),
    IMPROVED: z.object({ translation: z.string() }),
  },
  // `improving` runs only after evaluating set translation + evaluation.
  states: {
    translating: {},
    evaluating: {
      // Narrowed states extend the base schema instead of re-declaring it.
      schemas: { context: contextSchema.extend({ translation: z.string() }) },
    },
    checking: {},
    improving: {
      schemas: {
        context: contextSchema.extend({
          translation: z.string(),
          evaluation: translationEvaluationSchema,
        }),
      },
    },
    done: {
      schemas: { context: contextSchema.extend({ translation: z.string() }) },
    },
  },
  requests: {
    translateText: {
      schemas: {
        input: z.object({ text: z.string(), targetLanguage: z.string() }),
        output: z.string(),
      },
      model: "translator",
      system:
        "You are an expert literary translator. Translate faithfully into the target language, preserving register, tone, idiom, and cultural nuance rather than translating word for word. Return only the translation.",
      prompt: ({ input }) => `Translate this text to ${input.targetLanguage}:\n${input.text}`,
    },
    evaluateTranslation: {
      schemas: {
        input: z.object({ original: z.string(), translation: z.string() }),
        output: translationEvaluationSchema,
      },
      model: "evaluator",
      system:
        "You are a bilingual translation reviewer. Score the translation 1-10 for overall quality and judge whether it preserves tone, preserves nuance, and is culturally accurate. List specific issues and concrete improvement suggestions. Be strict: reserve scores of 8+ for translations that read naturally to a native speaker.",
      prompt: ({ input }) => `Original: ${input.original}\nTranslation: ${input.translation}`,
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
      model: "improver",
      system:
        "You are an expert literary translator revising a draft. Apply the reviewer feedback to fix the listed issues while keeping everything that already works. Return only the improved translation.",
      prompt: ({ input }) =>
        [
          `Original: ${input.original}`,
          `Translation: ${input.translation}`,
          `Issues: ${input.evaluation.specificIssues.join(", ")}`,
          `Suggestions: ${input.evaluation.improvementSuggestions.join(", ")}`,
        ].join("\n"),
    },
  },
});

export const aiSdkEvaluatorOptimizerMachine = agentSetup.createMachine({
  id: "ai-sdk-evaluator-optimizer",
  context: ({ input }) => ({
    text: input.text,
    targetLanguage: input.targetLanguage,
    translation: null,
    evaluation: null,
    iterations: 0,
    maxIterations: input.maxIterations,
  }),
  initial: "translating",
  states: {
    translating: {
      invoke: {
        id: "translateText",
        src: "translateText",
        input: ({ context }) => ({
          text: context.text,
          targetLanguage: context.targetLanguage,
        }),
        onDone: ({ output }, enq) => {
          enq.emit({ type: "TRANSLATED", translation: output });
          return {
            target: "evaluating",
            context: { translation: output },
          };
        },
      },
    },
    evaluating: {
      invoke: {
        id: "evaluateTranslation",
        src: "evaluateTranslation",
        input: ({ context }) => ({
          original: context.text,
          translation: context.translation,
        }),
        onDone: ({ context, output }, enq) => {
          enq.emit({
            type: "EVALUATED",
            qualityScore: output.qualityScore,
            iteration: context.iterations + 1,
          });
          return {
            target: "checking",
            context: {
              evaluation: output,
              iterations: context.iterations + 1,
            },
          };
        },
      },
    },
    checking: {
      type: "choice",
      choice: ({ context }) =>
        translationPasses(context.evaluation) || context.iterations >= context.maxIterations
          ? { target: "done" }
          : { target: "improving" },
    },
    improving: {
      invoke: {
        id: "improveTranslation",
        src: "improveTranslation",
        input: ({ context }) => ({
          original: context.text,
          translation: context.translation,
          evaluation: context.evaluation,
        }),
        onDone: ({ output }, enq) => {
          enq.emit({ type: "IMPROVED", translation: output });
          return {
            target: "evaluating",
            context: { translation: output },
          };
        },
      },
    },
    done: {
      type: "final",
      output: ({ context }) => ({
        translation: context.translation,
        evaluation: context.evaluation,
        iterations: context.iterations,
      }),
    },
  },
});

export async function runAiSdkEvaluatorOptimizerExample() {
  const result = await runAgent(aiSdkEvaluatorOptimizerMachine, {
    input: {
      text: "Hello friend",
      targetLanguage: "Spanish",
      maxIterations: 3,
    },
    ...createAiSdkExecutors({ models }),
    onTransition: (snapshot) =>
      console.log(
        "[state]",
        JSON.stringify(snapshot.value),
        `iteration ${snapshot.context.iterations}`,
      ),
    on: {
      TRANSLATED: () => console.log("[translated] first draft ready"),
      EVALUATED: (e) =>
        console.log(`[evaluated] iteration ${e.iteration}: score ${e.qualityScore}/10`),
      IMPROVED: () => console.log("[improved] applied reviewer feedback"),
    },
  });
  if (result.status !== "done") {
    throw new Error(`Evaluator-optimizer example did not complete: ${result.status}`);
  }
  return result.output;
}

runExampleMain(import.meta.url, async () => {
  console.log(await runAiSdkEvaluatorOptimizerExample());
});
