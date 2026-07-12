/**
 * Vercel AI SDK parallel review — parallel processing, ported to `setupAgent`
 * with co-located `requests:`. Three per-aspect reviews (security,
 * performance, maintainability) each run as their own model call, fanned out
 * concurrently via a `type: 'parallel'` region, then a fourth request
 * summarizes them — matching the source example, where each aspect is an
 * independent `generateText`/`Output.object` call run under `Promise.all`.
 *
 * Compare: https://ai-sdk.dev/docs/agents/workflows#parallel-processing
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/ai-sdk-parallel-review/index.ts
 */
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { setupAgent, runAgent } from "../../src/index.js";
import { createAiSdkExecutors, defineModels } from "../../src/ai-sdk/index.js";
import { runExampleMain } from "../helpers/main.js";

const reviewSchema = z.object({
  type: z.enum(["security", "performance", "maintainability"]),
  findings: z.array(z.string()),
  severity: z.enum(["low", "medium", "high"]),
});
type Review = z.infer<typeof reviewSchema>;

// Per-aspect review output (the model returns findings + severity; the fixed
// `type` tag is stamped on in `onDone` so the schema the model fills is small).
const aspectReviewSchema = z.object({
  findings: z.array(z.string()),
  severity: z.enum(["low", "medium", "high"]),
});

export const models = defineModels({
  securityReviewer: openai("gpt-5.4-mini"),
  performanceReviewer: openai("gpt-5.4-mini"),
  maintainabilityReviewer: openai("gpt-5.4-mini"),
  summarizer: openai("gpt-5.4-mini"),
});

const codeInput = z.object({ code: z.string() });

const contextSchema = z.object({
  code: z.string(),
  security: reviewSchema.nullable(),
  performance: reviewSchema.nullable(),
  maintainability: reviewSchema.nullable(),
  summary: z.string().nullable(),
});

const agentSetup = setupAgent({
  models,
  context: contextSchema,
  input: codeInput,
  output: z.object({
    reviews: z.array(reviewSchema),
    summary: z.string(),
  }),
  // summarizing sets summary before done reads it — narrow it non-null there.
  states: {
    reviewing: {},
    summarizing: {},
    done: {
      schemas: { context: contextSchema.extend({ summary: z.string() }) },
    },
  },
  requests: {
    reviewSecurity: {
      schemas: { input: codeInput, output: aspectReviewSchema },
      model: "securityReviewer",
      system:
        "You are a security reviewer. Identify injection, auth, secret-handling, and unsafe-eval risks. List concrete findings and rate overall severity.",
      prompt: ({ input }) => `Review this code for security issues:\n${input.code}`,
    },
    reviewPerformance: {
      schemas: { input: codeInput, output: aspectReviewSchema },
      model: "performanceReviewer",
      system:
        "You are a performance reviewer. Identify hot-path allocations, redundant work, and complexity issues. List concrete findings and rate overall severity.",
      prompt: ({ input }) => `Review this code for performance issues:\n${input.code}`,
    },
    reviewMaintainability: {
      schemas: { input: codeInput, output: aspectReviewSchema },
      model: "maintainabilityReviewer",
      system:
        "You are a maintainability reviewer. Identify naming, structure, and readability problems. List concrete findings and rate overall severity.",
      prompt: ({ input }) => `Review this code for maintainability issues:\n${input.code}`,
    },
    summarizeCodeReviews: {
      schemas: {
        input: z.object({ reviews: z.array(reviewSchema) }),
        output: z.string(),
      },
      model: "summarizer",
      system:
        "Summarize multiple per-aspect code reviews into the key actions to take, highest severity first.",
      prompt: ({ input }) => JSON.stringify(input.reviews, null, 2),
    },
  },
});

function collectReviews(context: {
  security: Review | null;
  performance: Review | null;
  maintainability: Review | null;
}): Review[] {
  return [context.security, context.performance, context.maintainability].filter(
    (review): review is Review => review !== null,
  );
}

export const aiSdkParallelReviewMachine = agentSetup.createMachine({
  id: "ai-sdk-parallel-review",
  context: ({ input }) => ({
    code: input.code,
    security: null,
    performance: null,
    maintainability: null,
    summary: null,
  }),
  initial: "reviewing",
  states: {
    // The three aspect reviews are independent model calls; `type: 'parallel'`
    // runs them concurrently and only leaves `reviewing` once all three land.
    reviewing: {
      type: "parallel",
      onDone: { target: "summarizing" },
      states: {
        security: {
          initial: "active",
          states: {
            active: {
              invoke: {
                id: "reviewSecurity",
                src: "reviewSecurity",
                input: ({ context }) => ({ code: context.code }),
                onDone: ({ output }) => ({
                  target: "done",
                  context: {
                    security: { type: "security" as const, ...output },
                  },
                }),
              },
            },
            done: { type: "final" },
          },
        },
        performance: {
          initial: "active",
          states: {
            active: {
              invoke: {
                id: "reviewPerformance",
                src: "reviewPerformance",
                input: ({ context }) => ({ code: context.code }),
                onDone: ({ output }) => ({
                  target: "done",
                  context: {
                    performance: { type: "performance" as const, ...output },
                  },
                }),
              },
            },
            done: { type: "final" },
          },
        },
        maintainability: {
          initial: "active",
          states: {
            active: {
              invoke: {
                id: "reviewMaintainability",
                src: "reviewMaintainability",
                input: ({ context }) => ({ code: context.code }),
                onDone: ({ output }) => ({
                  target: "done",
                  context: {
                    maintainability: { type: "maintainability" as const, ...output },
                  },
                }),
              },
            },
            done: { type: "final" },
          },
        },
      },
    },
    summarizing: {
      invoke: {
        id: "summarizeCodeReviews",
        src: "summarizeCodeReviews",
        input: ({ context }) => ({ reviews: collectReviews(context) }),
        onDone: ({ output }) => ({
          target: "done",
          context: { summary: output },
        }),
      },
    },
    done: {
      type: "final",
      output: ({ context }) => ({
        reviews: collectReviews(context),
        summary: context.summary,
      }),
    },
  },
});

export async function runAiSdkParallelReviewExample(
  observe?: Parameters<typeof runAgent>[1]["onTransition"],
) {
  const result = await runAgent(aiSdkParallelReviewMachine, {
    input: { code: "const x = eval(input);" },
    ...createAiSdkExecutors({ models }),
    onTransition: observe,
  });
  if (result.status !== "done") {
    throw new Error(`Parallel review example did not complete: ${result.status}`);
  }
  return result.output;
}

runExampleMain(import.meta.url, async () => {
  console.log(
    await runAiSdkParallelReviewExample((snapshot) =>
      console.log("[state]", JSON.stringify(snapshot.value)),
    ),
  );
});
