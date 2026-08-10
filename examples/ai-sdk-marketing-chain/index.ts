/**
 * Vercel AI SDK marketing chain — sequential processing, ported to
 * `setupAgent` with co-located `requests:`.
 *
 * The first pass writes a plain blurb with no call to action, so the reviewer
 * always fails it and every run shows the improvement step: original copy,
 * rubric, improved copy.
 *
 * Compare: https://ai-sdk.dev/docs/agents/workflows#sequential-processing-chains
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/ai-sdk-marketing-chain/index.ts
 */
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { setupAgent, runAgent } from "@statelyai/agent";
import { createAiSdkExecutors, defineModels } from "@statelyai/agent/ai-sdk";

const qualitySchema = z.object({
  hasCallToAction: z.boolean(),
  emotionalAppeal: z.number().min(1).max(10),
  clarity: z.number().min(1).max(10),
});

function qualityPasses(quality: z.infer<typeof qualitySchema> | null) {
  return (
    !!quality && quality.hasCallToAction && quality.emotionalAppeal >= 7 && quality.clarity >= 7
  );
}

export const models = defineModels({
  copywriter: openai("gpt-5.4-mini"),
  evaluator: openai("gpt-5.4-mini"),
  improver: openai("gpt-5.4-mini"),
});

const contextSchema = z.object({
  product: z.string(),
  /** Card 1: the plain first-pass blurb. */
  originalCopy: z.string().nullable(),
  /** Card 2: the reviewer's rubric, one line. */
  rubricNotes: z.string().nullable(),
  /** Card 3: the rewrite that addresses the rubric. */
  improvedCopy: z.string().nullable(),
  quality: qualitySchema.nullable(),
});

/**
 * Three compact cards — improved copy, reviewer rubric, original copy — as one
 * prose string, with the structured values nested under `detail`.
 */
function summarize(context: z.infer<typeof contextSchema>) {
  const originalCopy = context.originalCopy ?? "";
  const rubricNotes = context.rubricNotes ?? "not reviewed";
  const improvedCopy = context.improvedCopy ?? originalCopy;
  return {
    summary: [
      `**Improved copy**\n\n${improvedCopy}`,
      `**Reviewer**\n\n${rubricNotes}`,
      `**Original copy**\n\n${originalCopy}`,
    ].join("\n\n"),
    detail: {
      originalCopy,
      rubricNotes,
      improvedCopy,
      quality: context.quality ?? { hasCallToAction: false, emotionalAppeal: 1, clarity: 1 },
    },
  };
}

/** "No call to action; appeal 5/10; clarity 6/10" */
function rubricLine(quality: z.infer<typeof qualitySchema>) {
  return [
    quality.hasCallToAction ? "Has a call to action" : "No call to action",
    `appeal ${quality.emotionalAppeal}/10`,
    `clarity ${quality.clarity}/10`,
  ].join("; ");
}

const agentSetup = setupAgent({
  models,
  context: contextSchema,
  input: z.object({ product: z.string() }),
  // Leads with three compact cards as one prose string; the structured values
  // stay nested under `detail`.
  output: z.object({
    summary: z.string(),
    detail: z.object({
      originalCopy: z.string(),
      rubricNotes: z.string(),
      improvedCopy: z.string(),
      quality: qualitySchema,
    }),
  }),
  emitted: {
    EVALUATED: z.object({
      hasCallToAction: z.boolean(),
      emotionalAppeal: z.number(),
      clarity: z.number(),
    }),
  },
  // writing sets originalCopy before any state that reads it; evaluating also
  // sets quality before checking/improving/done — narrow both non-null there.
  states: {
    evaluating: { context: { originalCopy: z.string() } },
    improving: { context: { originalCopy: z.string(), quality: qualitySchema } },
    done: { context: { originalCopy: z.string(), quality: qualitySchema } },
  },
  requests: {
    writeMarketingCopy: {
      schemas: {
        input: z.object({ product: z.string() }),
        output: z.string(),
      },
      model: "copywriter",
      // A plain first pass on purpose: no call to action, so the reviewer always
      // fails it and the improvement step runs on every run.
      system:
        "You are writing a plain first-pass product blurb. Describe what the product is and does in at most two sentences. Stay factual, and do not add a call to action.",
      prompt: ({ input }) => `Write a first-pass blurb for: ${input.product}`,
    },
    evaluateMarketingCopy: {
      schemas: {
        input: z.object({ copy: z.string() }),
        output: qualitySchema,
      },
      model: "evaluator",
      system:
        "You review marketing copy. Report whether it has a clear call to action, then score emotional appeal (1-10) and clarity (1-10). Score strictly against direct-response standards.",
      prompt: ({ input }) => input.copy,
    },
    improveMarketingCopy: {
      schemas: {
        input: z.object({ copy: z.string(), quality: qualitySchema }),
        output: z.string(),
      },
      model: "improver",
      system:
        "You are a direct-response copy editor. Revise the copy to address the notes below while preserving its voice. Return only the improved copy, at most two sentences.",
      prompt: ({ input }) =>
        [
          !input.quality.hasCallToAction ? "Add a clear call to action." : "",
          input.quality.emotionalAppeal < 7 ? "Strengthen emotional appeal." : "",
          input.quality.clarity < 7 ? "Improve clarity and directness." : "",
          `Original copy: ${input.copy}`,
        ]
          .filter(Boolean)
          .join("\n"),
    },
  },
});

export const aiSdkMarketingChainMachine = agentSetup.createMachine({
  id: "ai-sdk-marketing-chain",
  context: ({ input }) => ({
    product: input.product,
    originalCopy: null,
    rubricNotes: null,
    improvedCopy: null,
    quality: null,
  }),
  initial: "writing",
  states: {
    writing: {
      invoke: {
        id: "writeMarketingCopy",
        src: "writeMarketingCopy",
        input: ({ context }) => ({ product: context.product }),
        onDone: ({ output }) => ({
          target: "evaluating",
          context: { originalCopy: output },
        }),
        onError: { target: "failed" },
      },
    },
    evaluating: {
      invoke: {
        id: "evaluateMarketingCopy",
        src: "evaluateMarketingCopy",
        input: ({ context }) => ({ copy: context.originalCopy }),
        onDone: ({ output }, enq) => {
          enq.emit({ type: "EVALUATED", ...output });
          return {
            target: "checking",
            context: { quality: output, rubricNotes: rubricLine(output) },
          };
        },
        onError: { target: "failed" },
      },
    },
    checking: {
      type: "choice",
      choice: ({ context }) =>
        qualityPasses(context.quality) ? { target: "done" } : { target: "improving" },
    },
    improving: {
      invoke: {
        id: "improveMarketingCopy",
        src: "improveMarketingCopy",
        input: ({ context }) => ({
          copy: context.originalCopy,
          quality: context.quality,
        }),
        onDone: ({ output }) => ({
          target: "done",
          context: { improvedCopy: output },
        }),
        onError: { target: "failed" },
      },
    },
    done: {
      type: "final",
      output: ({ context }) => summarize(context),
    },
    // Best-effort output when a model call fails.
    failed: {
      type: "final",
      output: ({ context }) => summarize(context),
    },
  },
});

export async function runAiSdkMarketingChainExample() {
  const result = await runAgent(aiSdkMarketingChainMachine, {
    input: { product: "state machines" },
    executors: createAiSdkExecutors({ models }),
    onTransition: (snapshot) => console.log("[state]", JSON.stringify(snapshot.value)),
    on: {
      EVALUATED: (e) =>
        console.log(
          `[evaluated] CTA ${e.hasCallToAction ? "yes" : "no"}, appeal ${e.emotionalAppeal}/10, clarity ${e.clarity}/10`,
        ),
    },
  });
  if (result.status !== "done") {
    throw new Error(`Marketing chain example did not complete: ${result.status}`);
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
    console.log(await runAiSdkMarketingChainExample());
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
