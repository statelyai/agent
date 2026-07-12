/**
 * Vercel AI SDK marketing chain — sequential processing, ported to
 * `setupAgent` with co-located `requests:`.
 *
 * Compare: https://ai-sdk.dev/docs/agents/workflows#sequential-processing-chains
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/ai-sdk-marketing-chain/index.ts
 */
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { setupAgent, runAgent } from "../../src/index.js";
import { createAiSdkExecutors, defineModels } from "../../src/ai-sdk/index.js";
import { runExampleMain } from "../helpers/main.js";

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
  copy: z.string().nullable(),
  quality: qualitySchema.nullable(),
  finalCopy: z.string().nullable(),
});

const agentSetup = setupAgent({
  models,
  context: contextSchema,
  input: z.object({ product: z.string() }),
  output: z.object({ copy: z.string(), quality: qualitySchema }),
  emitted: {
    EVALUATED: z.object({
      hasCallToAction: z.boolean(),
      emotionalAppeal: z.number(),
      clarity: z.number(),
    }),
  },
  // writing sets copy before any state that reads it; evaluating also sets
  // quality before checking/improving/done — narrow both non-null there.
  states: {
    writing: {},
    evaluating: {
      schemas: { context: contextSchema.extend({ copy: z.string() }) },
    },
    checking: {},
    improving: {
      schemas: {
        context: contextSchema.extend({ copy: z.string(), quality: qualitySchema }),
      },
    },
    done: {
      schemas: {
        context: contextSchema.extend({ copy: z.string(), quality: qualitySchema }),
      },
    },
  },
  requests: {
    writeMarketingCopy: {
      schemas: {
        input: z.object({ product: z.string() }),
        output: z.string(),
      },
      model: "copywriter",
      system:
        "You are a direct-response copywriter. Lead with the customer benefit, build emotional appeal, and end on one clear call to action. Keep it tight — a short paragraph, no headings.",
      prompt: ({ input }) =>
        `Write persuasive marketing copy for: ${input.product}. Focus on benefits and emotional appeal.`,
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
        "You are a copy editor. Revise the copy to address the notes below while preserving its voice. Return only the improved copy.",
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
    copy: null,
    quality: null,
    finalCopy: null,
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
          context: { copy: output },
        }),
      },
    },
    evaluating: {
      invoke: {
        id: "evaluateMarketingCopy",
        src: "evaluateMarketingCopy",
        input: ({ context }) => ({ copy: context.copy }),
        onDone: ({ output }, enq) => {
          enq.emit({ type: "EVALUATED", ...output });
          return {
            target: "checking",
            context: { quality: output },
          };
        },
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
          copy: context.copy,
          quality: context.quality,
        }),
        onDone: ({ output }) => ({
          target: "done",
          context: { finalCopy: output },
        }),
      },
    },
    done: {
      type: "final",
      output: ({ context }) => ({
        copy: context.finalCopy ?? context.copy,
        quality: context.quality,
      }),
    },
  },
});

export async function runAiSdkMarketingChainExample() {
  const result = await runAgent(aiSdkMarketingChainMachine, {
    input: { product: "state machines" },
    ...createAiSdkExecutors({ models }),
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

runExampleMain(import.meta.url, async () => {
  console.log(await runAiSdkMarketingChainExample());
});
