/**
 * Vercel AI SDK evaluator-optimizer — ported to `setupAgent` with
 * co-located `requests:`. Keeps the translate → evaluate → (improve →
 * evaluate)* loop, gated by a pure `always` transition that checks quality
 * and iteration budget.
 *
 * The first pass translates literally on purpose, so the strict reviewer always
 * has something to catch and every run shows a real before/after revision.
 *
 * The evaluator is split along the judgment/generation line. The grade is a
 * JUDGMENT: `evaluating` calls the AI SDK's `experimental_evaluate` with Jev
 * (`@ai-sdk/typesafe-ai`) as the evaluation model and asks one `score`
 * (`quality`, on `QUALITY_LEVELS`, mapped to the 1-10 `qualityScore`) and three
 * boolean questions (`preservesTone`, `preservesNuance`, `culturallyAccurate`,
 * each against `ASPECT_THRESHOLD`) in one call. The optimizer needs prose feedback
 * to act on, so a failing grade goes on to `critiquing`, where the text model
 * lists the issues and suggestions, told the grade rather than asked for it.
 *
 * Compare: https://ai-sdk.dev/docs/agents/workflows#evaluator-optimizer
 *
 * Run: OPENAI_API_KEY=... TYPESAFE_AI_API_KEY=... npx tsx examples/ai-sdk-evaluator-optimizer/index.ts
 */
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { createAsyncLogic } from "xstate";
import { experimental_evaluate as evaluate, type Experimental_EvaluationModel } from "ai";
import { typeSafeAi } from "@ai-sdk/typesafe-ai";
import { setupAgent, runAgent } from "@statelyai/agent";
import { createAiSdkExecutors } from "@statelyai/agent/ai-sdk";

const translationEvaluationSchema = z.object({
  qualityScore: z.number().min(1).max(10),
  preservesTone: z.boolean(),
  preservesNuance: z.boolean(),
  culturallyAccurate: z.boolean(),
  specificIssues: z.array(z.string()),
  improvementSuggestions: z.array(z.string()),
});

type TranslationEvaluation = z.infer<typeof translationEvaluationSchema>;

/** A translation passes at or above this 1-10 quality (with every aspect held). */
export const PASSING_QUALITY = 8;

/** An aspect (tone, nuance, cultural accuracy) holds when Jev's probability clears this. */
export const ASPECT_THRESHOLD = 0.5;

/** How well a translation reads, lowest to highest (mapped to a 1-10 quality). */
export const QUALITY_LEVELS = [
  "Wrong or unreadable: the meaning is lost or garbled.",
  "The meaning is mostly there, but it is a word-for-word rendering a native speaker finds awkward.",
  "Accurate and grammatical, but stiff, or it calques an idiom instead of using the local equivalent.",
  "Reads naturally to a native speaker, with at most a minor word-choice issue.",
  "Reads as if written in the target language: idiomatic, right register, nuance intact.",
] as const;

/** A `QUALITY_LEVELS` answer as the 1-10 `qualityScore` the machine reports. */
export function toQualityScore(level: number): number {
  return Math.round(1 + (level / (QUALITY_LEVELS.length - 1)) * 9);
}

/**
 * The grade as a judgment: the original, the translation, and the target
 * language are the state; one `score` and three boolean questions are asked in
 * one call. The judge model is injected by tests and hosts; the default is
 * Jev, which reads `TYPESAFE_AI_API_KEY` from the environment.
 */
export function createGradeTranslation(model: Experimental_EvaluationModel = judgeModel) {
  return createAsyncLogic<
    {
      answers: {
        quality: { score: number };
        preservesTone: { probability: number };
        preservesNuance: { probability: number };
        culturallyAccurate: { probability: number };
      };
    },
    { original: string; translation: string; targetLanguage: string }
  >({
    run: async ({ input, signal }) => {
      const { answers } = await evaluate({
        model,
        state: {
          original: input.original,
          translation: input.translation,
          targetLanguage: input.targetLanguage,
        },
        questions: {
          quality: {
            type: "score" as const,
            instructions:
              "How well does `translation` render `original` in `targetLanguage` for a native speaker?",
            criteria: QUALITY_LEVELS,
          },
          preservesTone: {
            type: "boolean" as const,
            instructions: "Does `translation` keep the tone and register of `original`?",
          },
          preservesNuance: {
            type: "boolean" as const,
            instructions:
              "Does `translation` keep the nuance of `original`, using the target language's own idiom rather than a literal calque?",
          },
          culturallyAccurate: {
            type: "boolean" as const,
            instructions: "Is `translation` culturally accurate for speakers of `targetLanguage`?",
          },
        },
        abortSignal: signal,
      });
      return { answers };
    },
  });
}

function translationPasses(evaluation: TranslationEvaluation | null) {
  return (
    !!evaluation &&
    evaluation.qualityScore >= PASSING_QUALITY &&
    evaluation.preservesTone &&
    evaluation.preservesNuance &&
    evaluation.culturallyAccurate
  );
}

const models = {
  translator: openai("gpt-5.4-mini"),
  critic: openai("gpt-5.4-mini"),
  improver: openai("gpt-5.4-mini"),
};

/**
 * The judge: TypeSafe's Jev through the AI SDK's evaluation-model provider.
 * Reads `TYPESAFE_AI_API_KEY`. Tests pass a mock evaluation model instead.
 */
const judgeModel: Experimental_EvaluationModel = typeSafeAi.evaluationModel("jev-latest");

const contextSchema = z.object({
  text: z.string(),
  targetLanguage: z.string(),
  translation: z.string().nullable(),
  /** The literal first pass, kept so the demo can show before/after. */
  firstDraft: z.string().nullable(),
  /** Issues the last revision was asked to fix; rendered only in `output`. */
  revisedIssues: z.array(z.string()).nullable(),
  evaluation: translationEvaluationSchema.nullable(),
  iterations: z.number(),
  maxIterations: z.number(),
});

/** "Score 6/10 — literal calque; wrong register" */
function reviewLine(evaluation: TranslationEvaluation) {
  const issues = evaluation.specificIssues.join("; ");
  return `Score ${evaluation.qualityScore}/10${issues ? ` — ${issues}` : " — reads naturally"}`;
}

const agentSetup = setupAgent({
  models,
  actors: {
    // The grade: a Jev judgment (see createGradeTranslation).
    gradeTranslation: createGradeTranslation(),
  },
  context: contextSchema,
  input: z.object({
    text: z.string(),
    targetLanguage: z.string(),
    maxIterations: z.number().default(3),
  }),
  // Leads with a short human-readable summary (final, first draft, what the
  // revision fixed); the structured values stay nested under `detail`.
  output: z.object({
    summary: z.string(),
    qualityScore: z.number(),
    iterations: z.number(),
    detail: z.object({
      firstDraft: z.string(),
      translation: z.string(),
      evaluation: translationEvaluationSchema.nullable(),
    }),
  }),
  emitted: {
    TRANSLATED: z.object({ translation: z.string() }),
    EVALUATED: z.object({ qualityScore: z.number(), iteration: z.number() }),
    IMPROVED: z.object({ translation: z.string() }),
  },
  // `improving` runs only after evaluating set translation + evaluation.
  states: {
    evaluating: { schemas: { context: contextSchema.extend({ translation: z.string() }) } },
    critiquing: {
      schemas: {
        context: contextSchema.extend({
          translation: z.string(),
          evaluation: translationEvaluationSchema,
        }),
      },
    },
    improving: {
      schemas: {
        context: contextSchema.extend({
          translation: z.string(),
          evaluation: translationEvaluationSchema,
        }),
      },
    },
    done: { schemas: { context: contextSchema.extend({ translation: z.string() }) } },
  },
  requests: {
    translateText: {
      schemas: {
        input: z.object({ text: z.string(), targetLanguage: z.string() }),
        output: z.string(),
      },
      model: "translator",
      // A deliberately literal first pass: the reviewer always has something to
      // catch, so the loop demonstrates a real revision on every run.
      system:
        "You are a fast first-pass translator. Translate the text literally, close to word for word, without hunting for the idiomatic equivalent in the target language. Return only the translation.",
      prompt: ({ input }) => `Translate this text to ${input.targetLanguage}:\n${input.text}`,
    },
    // The prose feedback the optimizer acts on, for a grade that failed.
    critiqueTranslation: {
      schemas: {
        input: z.object({
          original: z.string(),
          translation: z.string(),
          evaluation: translationEvaluationSchema,
        }),
        output: translationEvaluationSchema.pick({
          specificIssues: true,
          improvementSuggestions: true,
        }),
      },
      model: "critic",
      system:
        "You are a bilingual translation reviewer. The translation has already been graded and did not pass. List at most two specific issues and matching improvement suggestions, each a short phrase, that explain the grade.",
      prompt: ({ input }) =>
        [
          `Original: ${input.original}`,
          `Translation: ${input.translation}`,
          `Quality: ${input.evaluation.qualityScore}/10`,
          `Preserves tone: ${input.evaluation.preservesTone ? "yes" : "no"}`,
          `Preserves nuance: ${input.evaluation.preservesNuance ? "yes" : "no"}`,
          `Culturally accurate: ${input.evaluation.culturallyAccurate ? "yes" : "no"}`,
        ].join("\n"),
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
    firstDraft: null,
    revisedIssues: null,
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
          enq.emit({ type: "TRANSLATED", translation: output.result });
          return {
            target: "evaluating",
            context: { translation: output.result, firstDraft: output.result },
          };
        },
        // Nothing was translated, so there is no best-effort answer to give:
        // the run ends in `failed`, not in `done` with an empty string.
        onError: { target: "failed" },
      },
    },
    // The grade: one Jev call, thresholds applied here. A failing grade needs
    // prose feedback before the optimizer can act on it.
    evaluating: {
      invoke: {
        id: "gradeTranslation",
        src: "gradeTranslation",
        input: ({ context }) => ({
          original: context.text,
          translation: context.translation,
          targetLanguage: context.targetLanguage,
        }),
        onDone: ({ context, output: { answers } }, enq) => {
          const evaluation: TranslationEvaluation = {
            qualityScore: toQualityScore(answers.quality.score),
            preservesTone: answers.preservesTone.probability >= ASPECT_THRESHOLD,
            preservesNuance: answers.preservesNuance.probability >= ASPECT_THRESHOLD,
            culturallyAccurate: answers.culturallyAccurate.probability >= ASPECT_THRESHOLD,
            specificIssues: [],
            improvementSuggestions: [],
          };
          enq.emit({
            type: "EVALUATED",
            qualityScore: evaluation.qualityScore,
            iteration: context.iterations + 1,
          });
          return {
            target: translationPasses(evaluation) ? "checking" : "critiquing",
            context: { evaluation, iterations: context.iterations + 1 },
          };
        },
        // A translation exists; only the review is missing. `done` reports it
        // with whatever score the previous pass produced.
        onError: { target: "done" },
      },
    },
    critiquing: {
      invoke: {
        id: "critiqueTranslation",
        src: "critiqueTranslation",
        input: ({ context }) => ({
          original: context.text,
          translation: context.translation,
          evaluation: context.evaluation,
        }),
        onDone: ({ context, output }) => ({
          target: "checking",
          context: { evaluation: { ...context.evaluation, ...output.result } },
        }),
        // The grade stands, but there is no feedback to improve from: `done`
        // reports the translation with its grade.
        onError: { target: "done" },
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
        onDone: ({ context, output }, enq) => {
          enq.emit({ type: "IMPROVED", translation: output.result });
          return {
            target: "evaluating",
            context: {
              translation: output.result,
              revisedIssues: context.evaluation.specificIssues,
            },
          };
        },
        // The previous translation stands; `done` reports it unrevised.
        onError: { target: "done" },
      },
    },
    done: {
      type: "final",
      // The prose summary is rendered here, from context, rather than kept in
      // context and patched on every transition.
      output: ({ context }) => ({
        summary: [
          `**Final translation (${context.targetLanguage})**\n\n${context.translation}`,
          `**First draft**\n\n${context.firstDraft ?? context.translation}`,
          `**Reviewer**\n\n${context.evaluation ? reviewLine(context.evaluation) : "not reviewed"}${
            context.revisedIssues?.length
              ? `\n\nRevised to fix: ${context.revisedIssues.join("; ")}`
              : ""
          }`,
        ].join("\n\n"),
        qualityScore: context.evaluation?.qualityScore ?? 0,
        iterations: context.iterations,
        detail: {
          firstDraft: context.firstDraft ?? "",
          translation: context.translation,
          evaluation: context.evaluation,
        },
      }),
    },
    // The first pass never produced a translation, so there is nothing to
    // report but the failure itself.
    failed: {
      type: "final",
      output: ({ context }) => ({
        summary: `Translation into ${context.targetLanguage} failed before a first draft existed.`,
        qualityScore: 0,
        iterations: context.iterations,
        detail: { firstDraft: "", translation: "", evaluation: null },
      }),
    },
  },
});

export async function runAiSdkEvaluatorOptimizerExample() {
  const result = await runAgent(aiSdkEvaluatorOptimizerMachine, {
    input: {
      text: "The early bird catches the worm.",
      targetLanguage: "Japanese",
      maxIterations: 3,
    },
    executors: createAiSdkExecutors({ models }),
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

// Run directly (`tsx index.ts`); skipped when a test imports this module.
if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  if (!process.env.OPENAI_API_KEY || !process.env.TYPESAFE_AI_API_KEY) {
    console.error("Set OPENAI_API_KEY and TYPESAFE_AI_API_KEY to run this example.");
    process.exit(1);
  }
  void (async () => {
    console.log(await runAiSdkEvaluatorOptimizerExample());
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
