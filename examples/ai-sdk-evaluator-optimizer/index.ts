/**
 * Vercel AI SDK evaluator-optimizer — ported to `setupAgent` with
 * co-located `requests:`. Keeps the translate → evaluate → (improve →
 * evaluate)* loop, gated by a pure `always` transition that checks quality
 * and iteration budget.
 *
 * The first pass translates literally on purpose, so the strict reviewer always
 * has something to catch and every run shows a real before/after revision.
 *
 * Compare: https://ai-sdk.dev/docs/agents/workflows#evaluator-optimizer
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/ai-sdk-evaluator-optimizer/index.ts
 */
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { setupAgent, runAgent } from "@statelyai/agent";
import { createAiSdkExecutors, defineModels } from "@statelyai/agent/ai-sdk";

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
  /** The literal first pass, kept so the demo can show before/after. */
  firstDraft: z.string().nullable(),
  /** One line: what the reviewer asked the improver to fix. */
  revisionNotes: z.string().nullable(),
  /** One line: the latest score and remaining issues. */
  review: z.string().nullable(),
  evaluation: translationEvaluationSchema.nullable(),
  iterations: z.number(),
  maxIterations: z.number(),
});

/** "Score 6/10 — literal calque; wrong register" */
function reviewLine(evaluation: z.infer<typeof translationEvaluationSchema>) {
  const issues = evaluation.specificIssues.join("; ");
  return `Score ${evaluation.qualityScore}/10${issues ? ` — ${issues}` : " — reads naturally"}`;
}

const agentSetup = setupAgent({
  models,
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
    evaluating: { context: { translation: z.string() } },
    improving: { context: { translation: z.string(), evaluation: translationEvaluationSchema } },
    done: { context: { translation: z.string() } },
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
    evaluateTranslation: {
      schemas: {
        input: z.object({ original: z.string(), translation: z.string() }),
        output: translationEvaluationSchema,
      },
      model: "evaluator",
      system:
        "You are a bilingual translation reviewer. Score the translation 1-10 for overall quality and judge whether it preserves tone, preserves nuance, and is culturally accurate. List at most two specific issues and matching improvement suggestions, each a short phrase. Be strict: reserve scores of 8+ for translations that read naturally to a native speaker, and mark any literal calque of an idiom as failing nuance.",
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
    firstDraft: null,
    revisionNotes: null,
    review: null,
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
            context: { translation: output, firstDraft: output },
          };
        },
        // On failure, finish with an empty translation (best-effort output).
        onError: { target: "done", context: { translation: "", firstDraft: "" } },
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
              review: reviewLine(output),
              iterations: context.iterations + 1,
            },
          };
        },
        // On failure, finish with the current (already-set) translation.
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
          enq.emit({ type: "IMPROVED", translation: output });
          return {
            target: "evaluating",
            context: {
              translation: output,
              revisionNotes: context.evaluation.specificIssues.join("; ") || "polish pass",
            },
          };
        },
        // On failure, finish with the prior translation (best-effort output).
        onError: { target: "done" },
      },
    },
    done: {
      type: "final",
      output: ({ context }) => ({
        summary: [
          `**Final translation (${context.targetLanguage})**\n\n${context.translation}`,
          `**First draft**\n\n${context.firstDraft ?? context.translation}`,
          `**Reviewer**\n\n${context.review ?? "not reviewed"}${
            context.revisionNotes ? `\n\nRevised to fix: ${context.revisionNotes}` : ""
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
  if (!process.env.OPENAI_API_KEY) {
    console.error("Set OPENAI_API_KEY to run this example.");
    process.exit(1);
  }
  void (async () => {
    console.log(await runAiSdkEvaluatorOptimizerExample());
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
