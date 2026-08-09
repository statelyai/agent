/**
 * Corrective RAG (CRAG) — LangGraph's canonical self-correcting retrieval graph
 * as EXPLICIT, visible machine states.
 *
 * The idea (Yan et al. 2024): don't trust retrieval blindly. Grade each retrieved
 * document for relevance; if the retrieval is good enough, answer from it; if it
 * is not, rewrite the question and fall back to a second (external) index before
 * answering. One corrective pass, then generate.
 *
 * NOTE ON THE FALLBACK: LangGraph's CRAG calls a live web search API here. This
 * example calls NO network: the fallback is `SAMPLE_WEB_INDEX`, a second tiny
 * in-file corpus, and its results are prefixed `[sample web result]`. Swap the
 * `webSearch` actor for a real search tool and the machine is unchanged.
 *
 * LangGraph shape (docs/tutorials/rag/langgraph_crag) — nodes + a conditional edge:
 *
 *   START → retrieve → grade_documents → decide_to_generate ─┬─ generate → END
 *                                                            └─ transform_query
 *                                                               → web_search → generate → END
 *
 * Here every node is a state and `decide_to_generate` is a `choice` state, so the
 * correction branch is a real transition you can point at, not control flow hidden
 * inside node return values:
 *
 *   retrieving → grading → deciding ─┬─ generating → done
 *                                    └─ transformingQuery → webSearching → generating → done
 *
 * What maps to what:
 *   - retrieve            → `retrieving`  (typed plain actor over a sample corpus)
 *   - grade_documents     → `grading`     (ONE model request grades ALL docs — see note)
 *   - decide_to_generate  → `deciding`    (a `choice` state; the conditional edge)
 *   - transform_query     → `transformingQuery` (a model request that rewrites the question)
 *   - web_search          → `webSearching` (a second sample-data actor, clearly labeled)
 *   - generate            → `generating`  (grounded answer over the working doc set)
 *
 * Differences from LangGraph worth calling out:
 *   - Per-doc grading: LangGraph loops `retrieval_grader.invoke` once PER document.
 *     Here it's ONE request returning a yes/no per doc — cheaper (a single call),
 *     same decision. Swap to a per-doc loop (a nested invoke) if you want that.
 *   - The rewrite loop is bounded by construction: no edge returns to `retrieving`
 *     or `grading`, so at most ONE rewrite + web-search pass happens before
 *     `generating`. LangGraph relies on the same acyclic wiring (plus
 *     recursion_limit); here it's visible in the state graph itself.
 *   - Every model-call state has an `onError` route: grading/rewrite failures
 *     DEGRADE to answering from whatever docs exist; a generate failure lands in
 *     `failed` with a best-effort message. No unhandled model error aborts the run.
 *
 * Retrieval and web search are honest keyword-overlap actors over tiny in-file
 * corpora (NOT embeddings, NOT a live search API) — stand-ins with the same
 * machine shape as a real vector store / search tool.
 *
 * Dual-mode: `runCorrectiveRagExample(options?)` takes an injectable
 * `generateText` (tests pass a scripted mock — keyless CI); the direct run uses
 * real models.
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/corrective-rag/index.ts
 */
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { createAsyncLogic } from "xstate";
import { createAiSdkExecutors, defineModels } from "@statelyai/agent/ai-sdk";
import { runAgent, setupAgent, type AgentRequestExecutors } from "@statelyai/agent";

export const models = defineModels({
  crag: openai("gpt-5.4-mini"),
});

/**
 * Sample data: the primary knowledge base `retrieve` searches. Stand-in for a
 * vector store — replace the actor with a real similarity search and the machine
 * is unchanged.
 */
export const SAMPLE_CORPUS: Array<{ id: string; text: string }> = [
  {
    id: "memory-types",
    text: "LLM agent memory splits into short-term (the working context window of the current run) and long-term memory (facts persisted across sessions in an external store).",
  },
  {
    id: "memory-tools",
    text: "Agents read and write long-term memory through tools: a retrieval tool fetches relevant past facts, and a write tool saves new observations for later runs.",
  },
  {
    id: "reflection",
    text: "Reflection lets an agent critique its own output and revise it, improving reliability without any change to the underlying model weights.",
  },
  {
    id: "planning",
    text: "Task decomposition breaks a hard goal into ordered subgoals the agent tackles one at a time, a core part of agent planning.",
  },
];

/**
 * Sample data: a SEPARATE tiny corpus standing in for a web search index. The
 * web-search fallback returns canned results from here — clearly labeled, NOT a
 * live search API.
 */
export const SAMPLE_WEB_INDEX: Array<{ id: string; text: string }> = [
  {
    id: "weather",
    text: "As of the latest forecast, expect mild temperatures around 18C with scattered afternoon showers and light winds.",
  },
  {
    id: "prompt-injection",
    text: "Prompt injection is an attack where crafted input overrides an agent's instructions; defenses include input sanitization, privilege separation, and output filtering.",
  },
  {
    id: "vector-db",
    text: "A vector database indexes embeddings for approximate nearest-neighbor search, the retrieval backbone of most production RAG systems.",
  },
];

/** Content-word stop list for keyword scoring. */
const STOP_WORDS = new Set([
  "a",
  "an",
  "the",
  "is",
  "are",
  "of",
  "to",
  "in",
  "and",
  "what",
  "how",
  "why",
  "do",
  "does",
  "can",
  "i",
  "me",
  "my",
  "it",
  "that",
  "this",
  "for",
  "with",
  "about",
  "tell",
  "explain",
  "please",
]);

/** Honest keyword-overlap score (NOT embeddings): shared content words. */
function scoreDocument(question: string, text: string): number {
  const terms = new Set(
    question
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter((word) => word.length > 2 && !STOP_WORDS.has(word)),
  );
  const haystack = text.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (haystack.includes(term)) score += 1;
  }
  return score;
}

/** Top-N keyword matches over a corpus (score > 0), highest first. */
function searchCorpus(
  corpus: Array<{ id: string; text: string }>,
  question: string,
  limit: number,
): string[] {
  return corpus
    .map((doc) => ({ text: doc.text, score: scoreDocument(question, doc.text) }))
    .filter((scored) => scored.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map((scored) => scored.text);
}

// Grading output: one yes/no verdict per retrieved document, in order. This is
// the one-request-over-all-docs form (LangGraph loops one call per doc instead).
const gradeSchema = z.object({
  grades: z.array(
    z.object({
      relevant: z.boolean(),
    }),
  ),
});

const cragContextSchema = z.object({
  question: z.string(),
  // Set only on the correction branch (transform_query); null otherwise.
  rewrittenQuestion: z.string().nullable(),
  // The working document set: retrieved → filtered to relevant → web-augmented.
  documents: z.array(z.string()),
  // decide_to_generate's flag: no relevant docs survived grading.
  webSearchNeeded: z.boolean(),
  usedFallbackIndex: z.boolean(),
  generation: z.string().nullable(),
});

const agentSetup = setupAgent({
  models,
  context: cragContextSchema,
  input: z.object({
    question: z.string(),
  }),
  output: z.object({
    answer: z.string(),
    documents: z.array(z.string()),
    usedFallbackIndex: z.boolean(),
    rewrittenQuestion: z.string().nullable(),
  }),
  // `generating` always sets `generation` before `done` reads it — narrow it
  // non-null there. Declare ONLY the field that changes.
  states: {
    done: { context: { generation: z.string() } },
  },
  actors: {
    // retrieve: keyword search over the primary corpus. Top 3 docs.
    retrieve: createAsyncLogic<string[], { question: string }>({
      run: async ({ input }) => searchCorpus(SAMPLE_CORPUS, input.question, 3),
    }),
    // web_search: keyword search over the SEPARATE sample web index (canned,
    // clearly-labeled stand-in for a live search API). Top 2 docs.
    webSearch: createAsyncLogic<string[], { question: string }>({
      run: async ({ input }) => {
        const hits = searchCorpus(SAMPLE_WEB_INDEX, input.question, 2);
        return hits.length > 0
          ? hits.map((text) => `[sample web result] ${text}`)
          : ["[sample web result] No external results found for this query."];
      },
    }),
  },
  requests: {
    // grade_documents: one call grades every retrieved doc for relevance to the
    // question. Returns a yes/no verdict per doc, in order.
    gradeDocuments: {
      schemas: {
        input: z.object({
          question: z.string(),
          documents: z.array(z.string()),
        }),
        output: gradeSchema,
      },
      model: "crag",
      system:
        "You are a relevance grader for retrieval-augmented generation. For each " +
        "document, decide whether it contains information useful for answering the " +
        "question. Return one verdict per document, in the same order. Be strict: " +
        "grade a document relevant ONLY if it directly helps answer the question.",
      prompt: ({ input }) =>
        [
          `Question: ${input.question}`,
          "",
          "Documents:",
          ...input.documents.map((doc, i) => `[${i + 1}] ${doc}`),
        ].join("\n"),
    },
    // transform_query: rewrite the question to be a better standalone search query.
    rewriteQuery: {
      schemas: {
        input: z.object({ question: z.string() }),
        output: z.string(),
      },
      model: "crag",
      system:
        "Rewrite the user's question as a single, self-contained keyword search " +
        "query for a fallback document index. Keep the intent; make it explicit " +
        "and keyword-rich. Return only the rewritten query.",
      prompt: ({ input }) => input.question,
    },
    // generate: grounded answer over whatever documents survived (retrieved,
    // or web-augmented on the correction branch).
    generateAnswer: {
      schemas: {
        input: z.object({
          question: z.string(),
          documents: z.array(z.string()),
        }),
        output: z.string(),
      },
      model: "crag",
      system:
        "Answer the question using ONLY the provided documents. If the documents " +
        "do not contain the answer, say so plainly. Be concise.",
      prompt: ({ input }) =>
        [
          input.documents.length
            ? `Documents:\n${input.documents.map((doc, i) => `[${i + 1}] ${doc}`).join("\n")}`
            : "Documents: (none available)",
          `\nQuestion: ${input.question}`,
        ].join("\n"),
    },
  },
});

export const correctiveRagSchemas = agentSetup.schemas;

export const correctiveRagMachine = agentSetup.createMachine({
  id: "corrective-rag",
  context: ({ input }) => ({
    question: input.question,
    rewrittenQuestion: null,
    documents: [],
    webSearchNeeded: false,
    usedFallbackIndex: false,
    generation: null,
  }),
  initial: "retrieving",
  states: {
    // retrieve: pull candidate docs. No docs at all → skip grading, go straight
    // to the correction branch (nothing to grade).
    retrieving: {
      invoke: {
        src: "retrieve",
        input: ({ context }) => ({ question: context.question }),
        onDone: ({ output }) =>
          output.length > 0
            ? { target: "grading", context: { documents: output } }
            : { target: "deciding", context: { documents: output, webSearchNeeded: true } },
      },
    },
    // grade_documents: one request, a verdict per doc. Keep the relevant ones;
    // flag for web search if none survive. A grader failure degrades to
    // answering from all retrieved docs (skip correction).
    grading: {
      invoke: {
        src: "gradeDocuments",
        input: ({ context }) => ({
          question: context.question,
          documents: context.documents,
        }),
        onDone: ({ context, output }) => {
          const relevant = context.documents.filter(
            (_doc, i) => output.grades[i]?.relevant === true,
          );
          return {
            target: "deciding",
            context: {
              documents: relevant,
              webSearchNeeded: relevant.length === 0,
            },
          };
        },
        onError: { target: "generating" },
      },
    },
    // decide_to_generate: the conditional edge as a visible choice state.
    // Relevant docs survived → generate. None survived → correct via rewrite.
    deciding: {
      type: "choice",
      choice: ({ context }) =>
        context.webSearchNeeded ? { target: "transformingQuery" } : { target: "generating" },
    },
    // transform_query: rewrite the question for web search. A rewrite failure
    // degrades to generating from whatever docs we have.
    transformingQuery: {
      invoke: {
        src: "rewriteQuery",
        input: ({ context }) => ({ question: context.question }),
        onDone: ({ output }) => ({
          target: "webSearching",
          context: { rewrittenQuestion: output },
        }),
        onError: { target: "generating" },
      },
    },
    // web_search: fallback over the sample web index, using the rewritten query.
    // Append results to the working doc set, then generate.
    webSearching: {
      invoke: {
        src: "webSearch",
        input: ({ context }) => ({
          question: context.rewrittenQuestion ?? context.question,
        }),
        onDone: ({ context, output }) => ({
          target: "generating",
          context: {
            documents: [...context.documents, ...output],
            usedFallbackIndex: true,
          },
        }),
      },
    },
    // generate: grounded answer. A generate failure lands in `failed` with a
    // best-effort message rather than aborting the run.
    generating: {
      invoke: {
        src: "generateAnswer",
        input: ({ context }) => ({
          question: context.rewrittenQuestion ?? context.question,
          documents: context.documents,
        }),
        onDone: ({ output }) => ({
          target: "done",
          context: { generation: output },
        }),
        onError: { target: "failed" },
      },
    },
    done: {
      type: "final",
      output: ({ context }) => ({
        answer: context.generation,
        documents: context.documents,
        usedFallbackIndex: context.usedFallbackIndex,
        rewrittenQuestion: context.rewrittenQuestion,
      }),
    },
    // Best-effort terminal: generation failed outright.
    failed: {
      type: "final",
      output: ({ context }) => ({
        answer: "Unable to generate an answer for this question.",
        documents: context.documents,
        usedFallbackIndex: context.usedFallbackIndex,
        rewrittenQuestion: context.rewrittenQuestion,
      }),
    },
  },
});

export interface RunCorrectiveRagOptions {
  question?: string;
  /** Injected for tests; direct run supplies a real model executor. */
  generateText?: AgentRequestExecutors["generateText"];
  /** Observes each machine transition (the visible corrective flow). */
  onProgress?: (state: string) => void;
}

export interface CorrectiveRagResult {
  answer: string;
  documents: string[];
  usedFallbackIndex: boolean;
  rewrittenQuestion: string | null;
  progress: string[];
}

/** Runs the CRAG flow; records state progress so the correction branch is observable. */
export async function runCorrectiveRagExample(
  options: RunCorrectiveRagOptions = {},
): Promise<CorrectiveRagResult> {
  const {
    question = "How does long-term memory work for LLM agents?",
    generateText,
    onProgress,
  } = options;

  const progress: string[] = [];
  const result = await runAgent(correctiveRagMachine, {
    input: { question },
    ...(generateText
      ? { executors: { generateText } }
      : { executors: createAiSdkExecutors({ models }) }),
    onTransition: (snapshot) => {
      const state = String(snapshot.value);
      progress.push(state);
      onProgress?.(state);
    },
  });

  if (result.status !== "done") {
    throw new Error(`Corrective-RAG example did not complete: ${result.status}`);
  }
  return { ...result.output, progress };
}

// Run directly (`tsx index.ts`); skipped when a test imports this module.
if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  if (!process.env.OPENAI_API_KEY) {
    console.error("Set OPENAI_API_KEY to run this example.");
    process.exit(1);
  }
  void (async () => {
    const { generateText } = createAiSdkExecutors({ models });

    // Off-topic for the sample corpus — retrieval is weak, so CRAG corrects:
    // grade → rewrite → sample web index → generate. (The sample web index has a
    // prompt-injection doc, so the correction lands on real evidence.)
    const question = "What is prompt injection and how do you defend against it?";
    const result = await runCorrectiveRagExample({
      question,
      generateText,
      onProgress: (state) => console.log(`  → ${state}`),
    });

    console.log("\nQuestion:", question);
    if (result.rewrittenQuestion) console.log("Rewritten:", result.rewrittenQuestion);
    console.log("Used fallback sample web index:", result.usedFallbackIndex);
    console.log("\nAnswer:", result.answer);
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
