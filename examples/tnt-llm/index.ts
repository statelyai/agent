/**
 * TNT-LLM — taxonomy generation over a document set, ported from LangGraph's
 * TNT-LLM tutorial (Wan et al. 2024, "TnT-LLM: Text Mining at Scale with
 * Large Language Models").
 *
 * The idea: an LLM cannot read ten thousand chat logs at once, so summarize
 * each log, split the summaries into minibatches, draft a label taxonomy from
 * the first batch, refine it against each later batch, and finish with one
 * review pass. The taxonomy is the output; the batches are how it scales.
 *
 * LangGraph shape (examples/tutorials/tnt-llm):
 *
 *   START → summarize (map: one Send per doc) → get_minibatches → generate_taxonomy
 *         → update_taxonomy ─┬─ (more batches) → update_taxonomy
 *                            └─ (none left)   → review_taxonomy → END
 *
 * Machine shape — the batch index in context drives the loop:
 *
 *   summarizing (one spawned `summarize` child per document; each result lands by index)
 *     → batching → batchLimit ─┬─ generatingTaxonomy → capping → nextBatch
 *                              └─ failed
 *   nextBatch ─┬─ updatingTaxonomy → capping → nextBatch      (batchIndex + 1 < batches.length)
 *              └─ reviewingTaxonomy → reviewCapping → done
 *   (any taxonomy request error) → failed; a summarizer error leaves a placeholder
 *
 * What maps to what:
 *   - summarize (one Send per document) → `summarizing`: its entry spawns one
 *     `summarize` request child per document (`summary-<index>`); each
 *     `xstate.done.actor` writes `{ index, summary }` into `summaries[index]`,
 *     so the reduce is in document order whatever order the children finish
 *   - the implicit "all Sends finished" join → the done handler's target: once
 *     every slot is filled, `batching`
 *   - get_minibatches → `batching`: a pure `always` transition that computes
 *     the minibatches (arrays of document indices) from `batchSize`
 *   - generate_taxonomy → `generatingTaxonomy` (batch 0)
 *   - update_taxonomy → `updatingTaxonomy`, once per later batch
 *   - the "more batches?" conditional edge → `nextBatch` (a choice state)
 *   - review_taxonomy → `reviewingTaxonomy` (reviews against the last batch)
 *
 * Differences from LangGraph worth calling out:
 *   - A summarizer child that errors records "[summary unavailable]" for its
 *     document instead of stalling the join. In LangGraph a failing Send
 *     branch fails the whole superstep.
 *   - Minibatches are sequential slices, not a random shuffle: context stays
 *     replay-stable. Review reads the last batch rather than a random sample.
 *   - The taxonomy is capped at MAX_CATEGORIES by a choice state after every
 *     generate/update/review step, and the output counts what was dropped. The
 *     tutorial asks for a size in the prompt and takes what comes back.
 *   - The update loop runs once per later batch, and `batchLimit` checks the
 *     batch count against MAX_BATCHES before any taxonomy call runs.
 *
 * Stand-ins: SAMPLE_DOCUMENTS is twelve short fictional support-chat snippets
 * (billing, bug reports, feature requests, how-to questions) in place of the
 * tutorial's LangSmith run logs.
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/tnt-llm/index.ts
 */
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { createAiSdkExecutors } from "@statelyai/agent/ai-sdk";
import {
  createTextLogic,
  getStatePath,
  runAgent,
  setupAgent,
  type AgentRequestExecutors,
  type DoneActorEventOf,
} from "@statelyai/agent";

const models = { taxonomist: openai("gpt-6-luna") };

/** The taxonomy is truncated to this many categories after every step. */
export const MAX_CATEGORIES = 8;
/** More minibatches than this and the run fails before any taxonomy call. */
export const MAX_BATCHES = 12;
/**
 * Input boundary: one summarizer child is spawned per document, so the
 * document count is capped before the run starts rather than after the
 * fan-out has already happened.
 */
export const MAX_DOCUMENTS = 24;
export const DEFAULT_BATCH_SIZE = 4;

/** Sample data: fictional support-chat snippets across four intents. */
export const SAMPLE_DOCUMENTS: string[] = [
  "User: I was charged twice for my March subscription. Can you refund the duplicate?",
  "User: The export button does nothing on Safari. No file downloads, no error shown.",
  "User: Could you add a dark mode? The white background is harsh at night.",
  "User: How do I invite a teammate to my workspace?",
  "User: My invoice shows the old company address. How do I update billing details?",
  "User: The app crashes when I upload a PNG larger than 10 MB.",
  "User: It would be great to schedule reports to go out every Monday by email.",
  "User: Where do I find the API key for the integration settings?",
  "User: I downgraded to the free plan but was still billed for Pro this month.",
  "User: Search returns no results for words with accents, like 'café'.",
  "User: Please support SSO with Okta; our IT team requires it.",
  "User: How can I merge two projects without losing their comments?",
];

/** What a summarizer child that errored leaves in its document's slot. */
export const SUMMARY_UNAVAILABLE = "[summary unavailable]";
const SUMMARY_PREFIX = "summary-";

/**
 * The map branch: one conversation → one summary. Standalone logic so
 * `summarizing` can spawn it per document; `name` is what scripted executors
 * and traces key on.
 */
export const summarize = createTextLogic({
  schemas: {
    input: z.object({ document: z.string() }),
    output: z.object({ summary: z.string() }),
  },
  name: "summarize",
  model: "taxonomist",
  system: "Summarize this support conversation in one sentence that states what the user wants.",
  prompt: ({ input }) => `Conversation: ${input.document}`,
});

const categorySchema = z.object({ name: z.string(), description: z.string() });
const taxonomySchema = z.object({ taxonomy: z.array(categorySchema) });
type Category = z.infer<typeof categorySchema>;

const tntContextSchema = z.object({
  documents: z.array(z.string()),
  batchSize: z.number(),
  // One slot per document, filled by index as summarizer children land.
  summaries: z.array(z.string().nullable()),
  // Minibatches as arrays of document indices; batchIndex is the one in flight.
  batches: z.array(z.array(z.number())),
  batchIndex: z.number(),
  taxonomy: z.array(categorySchema),
  droppedCategories: z.number(),
});
type TntContext = z.infer<typeof tntContextSchema>;

/** Sequential slices of `batchSize` document indices. */
function minibatches(count: number, batchSize: number): number[][] {
  return Array.from({ length: Math.ceil(count / batchSize) }, (_, batch) =>
    Array.from(
      { length: Math.min(batchSize, count - batch * batchSize) },
      (_, i) => batch * batchSize + i,
    ),
  );
}

/** The reduce step: `{ index, summary }` into the document's slot. */
function withSummary(context: TntContext, actorId: string, summary: string): Array<string | null> {
  const index = Number(actorId.slice(SUMMARY_PREFIX.length));
  return context.summaries.map((existing, i) => (i === index ? summary : existing));
}

/** The summaries of one minibatch. */
function batchSummaries(context: TntContext, index: number): string[] {
  return (context.batches[index] ?? []).map((doc) => context.summaries[doc] ?? SUMMARY_UNAVAILABLE);
}

/** Truncates to MAX_CATEGORIES and counts what was dropped. */
function capTaxonomy(context: TntContext) {
  return {
    taxonomy: context.taxonomy.slice(0, MAX_CATEGORIES),
    droppedCategories: context.droppedCategories + context.taxonomy.length - MAX_CATEGORIES,
  };
}

function renderTaxonomy(taxonomy: Category[]): string[] {
  return taxonomy.map((category) => `- ${category.name} — ${category.description}`);
}

function failureReason(context: TntContext): string {
  if (context.batches.length > MAX_BATCHES) {
    return `${context.batches.length} minibatches exceed MAX_BATCHES (${MAX_BATCHES}); raise batchSize`;
  }
  return "a taxonomy request failed";
}

const taxonomyRequestInput = z.object({
  taxonomy: z.array(categorySchema),
  summaries: z.array(z.string()),
});

function taxonomyPrompt(input: z.infer<typeof taxonomyRequestInput>): string {
  return [
    `Summaries (${input.summaries.length}):`,
    ...input.summaries.map((summary, i) => `[${i + 1}] ${summary}`),
    "",
    "Current taxonomy:",
    ...(input.taxonomy.length ? renderTaxonomy(input.taxonomy) : ["(none yet)"]),
  ].join("\n");
}

const agentSetup = setupAgent({
  models,
  context: tntContextSchema,
  input: z.object({
    documents: z.array(z.string()).min(1).max(MAX_DOCUMENTS).optional(),
    batchSize: z.number().int().min(1).default(DEFAULT_BATCH_SIZE),
  }),
  output: z.object({
    report: z.string(),
    taxonomy: z.array(categorySchema),
    batches: z.array(z.array(z.number())),
    documents: z.array(z.string()),
    droppedCategories: z.number(),
  }),
  actors: { summarize },
  requests: {
    generateTaxonomy: {
      schemas: { input: taxonomyRequestInput, output: taxonomySchema },
      model: "taxonomist",
      system:
        "Propose a taxonomy of user intents that covers these conversation summaries. " +
        `Use at most ${MAX_CATEGORIES} categories, each with a short name and a one-sentence description.`,
      prompt: ({ input }) => taxonomyPrompt(input),
    },
    updateTaxonomy: {
      schemas: { input: taxonomyRequestInput, output: taxonomySchema },
      model: "taxonomist",
      system:
        "Refine the current intent taxonomy so it also covers these new summaries: add, merge, " +
        `or rename categories as needed. Keep at most ${MAX_CATEGORIES}. Return the full taxonomy.`,
      prompt: ({ input }) => taxonomyPrompt(input),
    },
    reviewTaxonomy: {
      schemas: { input: taxonomyRequestInput, output: taxonomySchema },
      model: "taxonomist",
      system:
        "Review the intent taxonomy against a sample of summaries: fix overlapping, vague or " +
        `missing categories. Keep at most ${MAX_CATEGORIES}. Return the final taxonomy.`,
      prompt: ({ input }) => taxonomyPrompt(input),
    },
  },
});

export const tntLlmSchemas = agentSetup.schemas;

export const tntLlmMachine = agentSetup.createMachine({
  id: "tnt-llm",
  context: ({ input }) => ({
    documents: input.documents ?? SAMPLE_DOCUMENTS,
    batchSize: input.batchSize,
    summaries: (input.documents ?? SAMPLE_DOCUMENTS).map(() => null),
    batches: [],
    batchIndex: 0,
    taxonomy: [],
    droppedCategories: 0,
  }),
  initial: "summarizing",
  states: {
    // MAP: one `summarize` child per document (the Send fan-out). REDUCE: each
    // settled child fills its document's slot; the last one moves on.
    summarizing: {
      entry: ({ context, actors }, enq) => {
        context.documents.forEach((document, index) => {
          enq.spawn(actors.summarize, { id: `${SUMMARY_PREFIX}${index}`, input: { document } });
        });
      },
      on: {
        "xstate.done.actor": ({ context, event }) => {
          const { actorId, output } = event as DoneActorEventOf<typeof summarize>;
          if (!actorId.startsWith(SUMMARY_PREFIX)) return undefined;
          const summaries = withSummary(context, actorId, output.result.summary);
          return summaries.every((summary) => summary !== null)
            ? { target: "batching", context: { summaries } }
            : { context: { summaries } };
        },
        // A failed child still fills its slot, so the join cannot stall.
        "xstate.error.actor": ({ context, event }) => {
          const { actorId } = event as unknown as { actorId: string };
          if (!actorId.startsWith(SUMMARY_PREFIX)) return undefined;
          const summaries = withSummary(context, actorId, SUMMARY_UNAVAILABLE);
          return summaries.every((summary) => summary !== null)
            ? { target: "batching", context: { summaries } }
            : { context: { summaries } };
        },
      },
    },
    // get_minibatches: pure, no model call.
    batching: {
      always: ({ context }) => ({
        target: "batchLimit",
        context: { batches: minibatches(context.documents.length, context.batchSize) },
      }),
    },
    batchLimit: {
      type: "choice",
      choice: ({ context }) =>
        context.batches.length <= MAX_BATCHES
          ? { target: "generatingTaxonomy", context: { batchIndex: 0 } }
          : { target: "failed" },
    },
    generatingTaxonomy: {
      invoke: {
        src: "generateTaxonomy",
        input: ({ context }) => ({ taxonomy: [], summaries: batchSummaries(context, 0) }),
        onDone: ({ output }) => ({
          target: "capping",
          context: { taxonomy: output.result.taxonomy },
        }),
        onError: { target: "failed" },
      },
    },
    updatingTaxonomy: {
      invoke: {
        src: "updateTaxonomy",
        input: ({ context }) => ({
          taxonomy: context.taxonomy,
          summaries: batchSummaries(context, context.batchIndex),
        }),
        onDone: ({ output }) => ({
          target: "capping",
          context: { taxonomy: output.result.taxonomy },
        }),
        onError: { target: "failed" },
      },
    },
    capping: {
      type: "choice",
      choice: ({ context }) =>
        context.taxonomy.length > MAX_CATEGORIES
          ? { target: "nextBatch", context: capTaxonomy(context) }
          : { target: "nextBatch" },
    },
    // The batch loop: update against every later batch, then review.
    nextBatch: {
      type: "choice",
      choice: ({ context }) =>
        context.batchIndex + 1 < context.batches.length
          ? { target: "updatingTaxonomy", context: { batchIndex: context.batchIndex + 1 } }
          : { target: "reviewingTaxonomy" },
    },
    reviewingTaxonomy: {
      invoke: {
        src: "reviewTaxonomy",
        input: ({ context }) => ({
          taxonomy: context.taxonomy,
          summaries: batchSummaries(context, context.batches.length - 1),
        }),
        onDone: ({ output }) => ({
          target: "reviewCapping",
          context: { taxonomy: output.result.taxonomy },
        }),
        onError: { target: "failed" },
      },
    },
    reviewCapping: {
      type: "choice",
      choice: ({ context }) =>
        context.taxonomy.length > MAX_CATEGORIES
          ? { target: "done", context: capTaxonomy(context) }
          : { target: "done" },
    },
    done: {
      type: "final",
      output: ({ context }) => ({
        report: [
          `Taxonomy of ${context.taxonomy.length} categories from ${context.documents.length} ` +
            `documents in ${context.batches.length} minibatch(es)` +
            (context.droppedCategories
              ? `; ${context.droppedCategories} over the cap dropped:`
              : ":"),
          ...renderTaxonomy(context.taxonomy),
        ].join("\n"),
        taxonomy: context.taxonomy,
        batches: context.batches,
        documents: context.documents,
        droppedCategories: context.droppedCategories,
      }),
    },
    // Best effort: whatever taxonomy existed when the run stopped.
    failed: {
      type: "final",
      output: ({ context }) => ({
        report: [
          `Taxonomy generation failed: ${failureReason(context)}.`,
          ...(context.taxonomy.length
            ? ["Partial taxonomy:", ...renderTaxonomy(context.taxonomy)]
            : []),
        ].join("\n"),
        taxonomy: context.taxonomy,
        batches: context.batches,
        documents: context.documents,
        droppedCategories: context.droppedCategories,
      }),
    },
  },
});

export interface RunTntLlmOptions {
  documents?: string[];
  batchSize?: number;
  /** Injected for tests; the direct run supplies a real model executor. */
  generateText?: AgentRequestExecutors["generateText"];
  onProgress?: (state: string) => void;
}

export interface TntLlmResult {
  report: string;
  taxonomy: Category[];
  batches: number[][];
  documents: string[];
  droppedCategories: number;
  /** `done`, or `failed` when the batch limit or a taxonomy request failed. */
  finalState: string;
  progress: string[];
}

/** Runs the taxonomy pipeline; records state progress so the batch loop is observable. */
export async function runTntLlmExample(options: RunTntLlmOptions = {}): Promise<TntLlmResult> {
  const { documents, batchSize, generateText, onProgress } = options;
  const progress: string[] = [];
  const result = await runAgent(tntLlmMachine, {
    input: { documents, batchSize: batchSize ?? DEFAULT_BATCH_SIZE },
    ...(generateText
      ? { executors: { generateText } }
      : { executors: createAiSdkExecutors({ models }) }),
    onTransition: (snapshot) => {
      const state = getStatePath(snapshot);
      progress.push(state);
      onProgress?.(state);
    },
  });

  if (result.status !== "done") {
    throw new Error(`TNT-LLM example did not complete: ${result.status}`);
  }
  return { ...result.output, finalState: getStatePath(result.snapshot), progress };
}

// Run directly (`tsx index.ts`); skipped when a test imports this module.
if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  if (!process.env.OPENAI_API_KEY) {
    console.error("Set OPENAI_API_KEY to run this example.");
    process.exit(1);
  }
  void (async () => {
    const { generateText } = createAiSdkExecutors({ models });
    const result = await runTntLlmExample({
      generateText,
      onProgress: (state) => console.log(`  → ${state}`),
    });
    console.log(`\n${result.report}`);
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
