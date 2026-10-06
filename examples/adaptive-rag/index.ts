/**
 * Adaptive RAG — LangGraph's routed, self-grading retrieval graph as EXPLICIT,
 * visible machine states, with every loop bounded by an exported budget.
 *
 * The idea (Jeong et al. 2024, plus Self-RAG's reflection steps from Asai et
 * al. 2023): route each question to the source that can answer it (a vector
 * store for in-domain questions, web search for current events), grade what
 * comes back, and grade the answer twice before trusting it — once for
 * hallucination (is it grounded in the documents?) and once for usefulness
 * (does it answer the question?). This port SUBSUMES LangGraph's Self-RAG
 * tutorial: Self-RAG is the same graph without the router
 * (https://langchain-ai.github.io/langgraph/tutorials/rag/langgraph_self_rag/).
 *
 * NOTE ON THE STAND-INS: LangGraph's tutorial uses a Chroma vector store and
 * the Tavily web search API. This example calls NO network: `retrieve` is a
 * keyword-overlap search over `SAMPLE_CORPUS`, and `webSearch` is the same over
 * `SAMPLE_WEB_INDEX`, whose results are prefixed `[sample web result]`. Swap
 * either actor for a real one and the machine is unchanged.
 *
 * LangGraph shape (tutorials/rag/langgraph_adaptive_rag):
 *
 *   START ─ route_question ─┬─ web_search ──────────────────────────────┐
 *                           └─ retrieve → grade_documents ─┬─ generate ◄┘
 *                                 ▲                         └─ transform_query
 *                                 └──────────────────────────────────┘
 *   generate → grade_generation_v_documents_and_question
 *     ├─ "not supported" → generate            (hallucination: regenerate)
 *     ├─ "not useful"    → transform_query     (grounded but off the question)
 *     └─ "useful"        → END
 *
 * Machine shape — each LangGraph node is a state; each conditional edge is a
 * `choice` state or the grader's own `onDone` targets; each loop passes through
 * a budget check against an exported constant:
 *
 *   routing → routed? ─┬─ searchingWeb ─────────────────────────┐
 *                      └─ retrieving ─┬─ grading ─┬─ generating ◄┘
 *                           ▲         │           │     │
 *                           │         └───────────┴─► rewriteBudget? ─┬─ rewriting ─┐
 *                           └─────────────────────────────────────────│─────────────┘
 *                                                                     └─ failed
 *   generating → checkingGrounding ─┬─ checkingUsefulness ─┬─ done
 *                                   │                      └─ rewriteBudget?
 *                                   └─ regenerationBudget? ─┬─ generating
 *                                                           └─ failed
 *
 * What maps to what:
 *   - route_question      → `routing` (a Jev `choice` over the datasource) +
 *                           `routed` (a choice state: the conditional edge)
 *   - retrieve            → `retrieving` (keyword actor over the sample corpus)
 *   - grade_documents     → `grading` (ONE Jev call, one boolean question per doc)
 *   - decide_to_generate  → grading's `onDone` targets: any relevant doc →
 *                           `generating`, none → the rewrite budget check
 *   - transform_query     → `rewriting` (request), behind `rewriteBudget`
 *   - web_search          → `searchingWeb` (keyword actor over the sample web index)
 *   - generate            → `generating`
 *   - grade_generation_v_documents_and_question → TWO states:
 *       hallucination grader → `checkingGrounding` (a Jev boolean question)
 *       answer grader        → `checkingUsefulness` (a Jev boolean question)
 *     so each verdict is its own transition instead of one function returning
 *     "not supported" / "useful" / "not useful".
 *
 * Differences from LangGraph worth calling out:
 *   - Routing and all three graders are JUDGMENTS, not generations. LangGraph
 *     runs each through a chat model with structured output. Here each one
 *     calls the AI SDK's `experimental_evaluate` with Jev
 *     (`@ai-sdk/typesafe-ai`) as the evaluation model, which answers a typed
 *     question over the evidence the machine already holds: a `choice` between
 *     the two datasources, one boolean question per document ("does it help
 *     answer the question?"), and a boolean question each for "is every claim
 *     supported by the
 *     documents?" and "does the answer address the question?". The machine
 *     compares each probability with an exported threshold
 *     (`RELEVANCE_THRESHOLD`, `GROUNDED_THRESHOLD`, `USEFUL_THRESHOLD`). The
 *     text model is reserved for the rewrite and the answer.
 *   - Bounded loops. LangGraph's two cycles (transform_query → retrieve, and
 *     "not supported" → generate) are bounded only by `recursion_limit`, which
 *     raises an error. Here `MAX_REWRITES` and `MAX_REGENERATIONS` are checked
 *     by choice states, and running out lands in `failed` with a best-effort
 *     output (the last draft, clearly marked unverified), not an exception.
 *   - One rewrite budget for both reasons to rewrite. A question that retrieves
 *     nothing relevant and an answer graded "not useful" both spend
 *     `MAX_REWRITES`, so the two loops cannot ping-pong forever between them.
 *   - Rewrites always go back to the vector store, as in LangGraph: a
 *     web-routed question graded "not useful" is rewritten and retried against
 *     the corpus.
 *   - An empty retrieval skips grading (nothing to grade) and goes straight to
 *     the rewrite budget check.
 *   - Per-doc grading is ONE Jev call with a boolean question per document, as in
 *     `examples/corrective-rag`; LangGraph calls the grader once per doc.
 *   - The two answer checks stay two states and two calls: grounding runs
 *     again after every regeneration, while usefulness runs only once an
 *     answer is grounded.
 *   - Every invoke has an `onError` that lands in `failed` with what the run
 *     had so far.
 *
 * Dual-mode: `runAdaptiveRagExample(options?)` takes an injectable
 * `generateText` and `judge` (tests pass scripted mocks, so CI needs no API
 * key); the direct run uses real models.
 *
 * Run: OPENAI_API_KEY=... TYPESAFE_AI_API_KEY=... npx tsx examples/adaptive-rag/index.ts
 */
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { createAsyncLogic } from "xstate";
import { experimental_evaluate as evaluate, type Experimental_EvaluationModel } from "ai";
import { typeSafeAi } from "@ai-sdk/typesafe-ai";
import { createAiSdkExecutors } from "@statelyai/agent/ai-sdk";
import {
  getStatePath,
  createAgentRuntime,
  runToQuiescence,
  setupAgent,
  type AgentRequestExecutors,
} from "@statelyai/agent";

const models = {
  rag: openai("gpt-5.4-mini"),
};

/**
 * The judge: TypeSafe's Jev through the AI SDK's evaluation-model provider.
 * Reads `TYPESAFE_AI_API_KEY`. Tests pass a mock evaluation model instead.
 */
const judgeModel: Experimental_EvaluationModel = typeSafeAi.evaluationModel("jev-latest");

/** Rewrites allowed per run, shared by "nothing relevant" and "not useful". */
export const MAX_REWRITES = 2;
/** Regenerations allowed after the hallucination grader rejects an answer. */
export const MAX_REGENERATIONS = 2;

/**
 * Sample data: the vector store `retrieve` searches. Stand-in for Chroma over
 * Lilian Weng's blog posts — a keyword search over four short passages, NOT
 * embeddings.
 */
export const SAMPLE_CORPUS: Array<{ id: string; text: string }> = [
  {
    id: "memory-types",
    text: "LLM agent memory splits into short-term memory (the working context window of the current run) and long-term memory (facts persisted across sessions in an external store).",
  },
  {
    id: "memory-tools",
    text: "Agents read and write long-term memory through tools: a retrieval tool fetches relevant past facts, and a write tool saves new observations for later runs.",
  },
  {
    id: "reflection",
    text: "Self-reflection lets an agent critique its own output and revise it, improving reliability without any change to the underlying model weights.",
  },
  {
    id: "planning",
    text: "Task decomposition breaks a hard goal into ordered subgoals the agent tackles one at a time, a core part of agent planning.",
  },
];

/**
 * Sample data: a SEPARATE tiny corpus standing in for Tavily web search.
 * Canned and clearly labeled; NOT a live search API.
 */
export const SAMPLE_WEB_INDEX: Array<{ id: string; text: string }> = [
  {
    id: "prompt-injection",
    text: "Latest guidance on prompt injection: treat retrieved text as untrusted, separate privileges between planning and tool execution, and filter model output before acting on it.",
  },
  {
    id: "weather",
    text: "As of the latest forecast, expect mild temperatures around 18C with scattered afternoon showers and light winds.",
  },
  {
    id: "framework-release",
    text: "This week's agent framework releases focused on durable execution: runs that survive restarts by persisting a snapshot after every step.",
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
  "you",
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
function scoreDocument(query: string, text: string): number {
  const terms = new Set(
    query
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
  query: string,
  limit: number,
): string[] {
  return corpus
    .map((doc) => ({ text: doc.text, score: scoreDocument(query, doc.text) }))
    .filter((scored) => scored.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map((scored) => scored.text);
}

/**
 * Source list for the answer prompt. Unnumbered on purpose: numbered documents
 * invite the answer to talk about them ("Document 2 is unrelated.").
 */
export function renderSources(documents: string[]): string {
  return documents.length ? documents.map((doc) => `- ${doc}`).join("\n") : "(none)";
}

/**
 * The answer is for the person who asked, not a report on retrieval: web
 * results arrive ungraded, so some are off-topic, and the answer must ignore
 * those silently rather than narrate them.
 */
export const ANSWER_SYSTEM_PROMPT = [
  "Answer the question using ONLY the facts in the source notes.",
  "Write the answer itself, addressed to the person who asked. Never mention the notes,",
  "documents, sources, or search results, and never say which ones are relevant or",
  "unrelated — silently ignore any that do not help.",
  "If the notes do not contain the answer, say you don't know. Use three sentences at most.",
].join(" ");

const datasourceSchema = z.enum(["vectorstore", "websearch"]);

/** A document is kept when Jev's probability that it helps clears this. */
export const RELEVANCE_THRESHOLD = 0.5;
/**
 * An answer passes the hallucination check when Jev's probability that every
 * claim is supported clears this. Higher than 0.5: passing an ungrounded
 * answer costs more than one extra regeneration.
 */
export const GROUNDED_THRESHOLD = 0.7;
/** An answer passes the usefulness check when Jev's probability clears this. */
export const USEFUL_THRESHOLD = 0.5;

/**
 * route_question as a judgment: the question is the state, the two
 * datasources are the labels of one `choice` question. The judge model is
 * injected by tests and hosts; the default is Jev.
 */
export function createRouteQuestion(model: Experimental_EvaluationModel = judgeModel) {
  return createAsyncLogic<
    { answers: { datasource: { choice: "vectorstore" | "websearch" } } },
    { question: string }
  >({
    run: async ({ input, signal }) => {
      const { answers } = await evaluate({
        model,
        state: { question: input.question },
        questions: {
          datasource: {
            type: "choice" as const,
            instructions: "Which datasource should answer `question`?",
            criteria: {
              vectorstore:
                "The sample vector store: documents about LLM agents (memory, tools, " +
                "self-reflection, planning), prompt engineering, and adversarial attacks on LLMs.",
              websearch:
                "Web search: current events, the latest news or guidance, or anything the " +
                "vector store does not cover.",
            },
          },
        },
        abortSignal: signal,
      });
      return { answers };
    },
  });
}

/** grade_documents as a judgment: one boolean question per document. */
export function createGradeDocuments(model: Experimental_EvaluationModel = judgeModel) {
  return createAsyncLogic<
    { answers: Record<string, { probability: number }> },
    { question: string; documents: string[] }
  >({
    run: async ({ input, signal }) => {
      const questions = Object.fromEntries(
        input.documents.map((_doc, index) => [
          `doc${index}`,
          {
            type: "boolean" as const,
            instructions: `Does \`documents[${index}]\` contain information that directly helps answer \`question\`?`,
            criteria: {
              true: "The document states facts the answer would be built from.",
              false: "The document is off-topic, or only shares vocabulary with the question.",
            },
          },
        ]),
      );
      const { answers } = await evaluate({
        model,
        state: { question: input.question, documents: input.documents },
        questions,
        abortSignal: signal,
      });
      return { answers };
    },
  });
}

/** The hallucination grader as a boolean question over the documents and the answer. */
export function createGradeGrounding(model: Experimental_EvaluationModel = judgeModel) {
  return createAsyncLogic<
    { answers: { grounded: { probability: number } } },
    { documents: string[]; generation: string }
  >({
    run: async ({ input, signal }) => {
      const { answers } = await evaluate({
        model,
        state: { documents: input.documents, answer: input.generation },
        questions: {
          grounded: {
            type: "boolean" as const,
            instructions: "Is every claim in `answer` supported by `documents`?",
            criteria: {
              true: "Each statement in the answer is stated in, or follows directly from, the documents.",
              false:
                "The answer adds at least one fact, figure, or detail the documents do not contain.",
            },
          },
        },
        abortSignal: signal,
      });
      return { answers };
    },
  });
}

/** The answer grader as a boolean question over the question and the answer. */
export function createGradeUsefulness(model: Experimental_EvaluationModel = judgeModel) {
  return createAsyncLogic<
    { answers: { useful: { probability: number } } },
    { question: string; generation: string }
  >({
    run: async ({ input, signal }) => {
      const { answers } = await evaluate({
        model,
        state: { question: input.question, answer: input.generation },
        questions: {
          useful: {
            type: "boolean" as const,
            instructions: "Does `answer` directly address `question`?",
            criteria: {
              true: "The answer responds to what the question asks.",
              false: "The answer is vague, off-topic, or responds to a different question.",
            },
          },
        },
        abortSignal: signal,
      });
      return { answers };
    },
  });
}

const adaptiveRagContextSchema = z.object({
  question: z.string(),
  // The current search query: the question, then each rewrite of it.
  query: z.string(),
  route: datasourceSchema.nullable(),
  // The working document set: retrieved → filtered to relevant, or web results.
  documents: z.array(z.string()),
  // Counts, not prose: the trail is RENDERED from these in `output`.
  retrievedCount: z.number(),
  relevantCount: z.number().nullable(),
  rewrites: z.number(),
  regenerations: z.number(),
  generation: z.string().nullable(),
  // Why the run stopped short; set only on the way into `failed`.
  failure: z.string().nullable(),
});

type AdaptiveRagContext = z.infer<typeof adaptiveRagContextSchema>;

/** The plain-language trail, rendered from the counters in context. */
function renderTrail(context: AdaptiveRagContext, verified: boolean): string {
  const parts: string[] = [];
  if (context.route === "websearch") {
    parts.push("Routed to web search (the sample web index).");
  } else if (context.route === "vectorstore") {
    parts.push("Routed to the vector store (the sample corpus).");
  } else {
    parts.push("Routing did not complete.");
  }
  if (context.route === "vectorstore" || context.rewrites > 0) {
    parts.push(
      context.relevantCount === null
        ? `Last retrieval returned ${context.retrievedCount} document(s).`
        : `Last retrieval returned ${context.retrievedCount} document(s); the grader kept ${context.relevantCount}.`,
    );
  }
  if (context.rewrites > 0) {
    parts.push(`Rewrote the question ${context.rewrites} of ${MAX_REWRITES} allowed time(s).`);
  }
  if (context.regenerations > 0) {
    parts.push(
      `Regenerated ${context.regenerations} of ${MAX_REGENERATIONS} allowed time(s) after the hallucination check.`,
    );
  }
  parts.push(
    verified
      ? "The answer passed the hallucination and usefulness checks."
      : `Stopped: ${context.failure ?? "unknown failure"}.`,
  );
  return parts.join(" ");
}

const agentSetup = setupAgent({
  models,
  context: adaptiveRagContextSchema,
  input: z.object({
    question: z.string(),
  }),
  output: z.object({
    answer: z.string(),
    trail: z.string(),
    route: datasourceSchema.nullable(),
    documents: z.array(z.string()),
    rewrites: z.number(),
    regenerations: z.number(),
  }),
  // `done` is only reachable through `checkingUsefulness`, after `generating`
  // set `generation`.
  states: {
    done: {
      schemas: { context: adaptiveRagContextSchema.extend({ generation: z.string() }) },
    },
  },
  actors: {
    // route_question and the three graders: Jev judgments (see create* above).
    routeQuestion: createRouteQuestion(),
    gradeDocuments: createGradeDocuments(),
    gradeGrounding: createGradeGrounding(),
    gradeUsefulness: createGradeUsefulness(),
    // retrieve: keyword search over the sample corpus. Top 3 docs.
    retrieve: createAsyncLogic<string[], { query: string }>({
      run: async ({ input }) => searchCorpus(SAMPLE_CORPUS, input.query, 3),
    }),
    // web_search: keyword search over the SEPARATE sample web index (a canned,
    // clearly labeled stand-in for Tavily). Top 2 docs.
    webSearch: createAsyncLogic<string[], { query: string }>({
      run: async ({ input }) => {
        const hits = searchCorpus(SAMPLE_WEB_INDEX, input.query, 2);
        return hits.length > 0
          ? hits.map((text) => `[sample web result] ${text}`)
          : ["[sample web result] No external results found for this query."];
      },
    }),
  },
  requests: {
    // transform_query: rewrite for better vector-store retrieval.
    rewriteQuestion: {
      schemas: {
        input: z.object({ question: z.string(), lastQuery: z.string() }),
        output: z.string(),
      },
      model: "rag",
      system:
        "You rewrite a question into a better version for vector-store retrieval. Reason " +
        "about the underlying intent and return only the improved question.",
      prompt: ({ input }) =>
        [
          `Original question: ${input.question}`,
          `Last search query (found nothing usable): ${input.lastQuery}`,
        ].join("\n"),
    },
    // generate: answer from the working documents.
    generateAnswer: {
      schemas: {
        input: z.object({ question: z.string(), documents: z.array(z.string()) }),
        output: z.string(),
      },
      model: "rag",
      system: ANSWER_SYSTEM_PROMPT,
      prompt: ({ input }) =>
        [`Question: ${input.question}`, "", "Source notes:", renderSources(input.documents)].join(
          "\n",
        ),
    },
  },
});

export const adaptiveRagSchemas = agentSetup.schemas;

export const adaptiveRagMachine = agentSetup.createMachine({
  id: "adaptive-rag",
  context: ({ input }) => ({
    question: input.question,
    query: input.question,
    route: null,
    documents: [],
    retrievedCount: 0,
    relevantCount: null,
    rewrites: 0,
    regenerations: 0,
    generation: null,
    failure: null,
  }),
  initial: "routing",
  states: {
    // route_question: the model picks the datasource.
    routing: {
      invoke: {
        src: "routeQuestion",
        input: ({ context }) => ({ question: context.question }),
        onDone: ({ output }) => ({
          target: "routed",
          context: { route: output.answers.datasource.choice },
        }),
        onError: ({ event }) => ({
          target: "failed",
          context: { failure: `routeQuestion failed: ${String(event.error)}` },
        }),
      },
    },
    // The router's conditional edge, as a state you can point at.
    routed: {
      type: "choice",
      choice: ({ context }) =>
        context.route === "websearch" ? { target: "searchingWeb" } : { target: "retrieving" },
    },
    // retrieve: nothing found → skip grading, go to the rewrite budget check.
    retrieving: {
      invoke: {
        src: "retrieve",
        input: ({ context }) => ({ query: context.query }),
        onDone: ({ output }) => ({
          target: output.length > 0 ? "grading" : "rewriteBudget",
          context: { documents: output, retrievedCount: output.length, relevantCount: null },
        }),
        onError: ({ event }) => ({
          target: "failed",
          context: { failure: `retrieve failed: ${String(event.error)}` },
        }),
      },
    },
    // grade_documents + decide_to_generate: keep the relevant docs; any left →
    // generate, none → rewrite (budget permitting).
    grading: {
      invoke: {
        src: "gradeDocuments",
        input: ({ context }) => ({ question: context.question, documents: context.documents }),
        onDone: ({ context, output }) => {
          const relevant = context.documents.filter(
            (_doc, i) => (output.answers[`doc${i}`]?.probability ?? 0) >= RELEVANCE_THRESHOLD,
          );
          return {
            target: relevant.length > 0 ? "generating" : "rewriteBudget",
            context: { documents: relevant, relevantCount: relevant.length },
          };
        },
        onError: ({ event }) => ({
          target: "failed",
          context: { failure: `gradeDocuments failed: ${String(event.error)}` },
        }),
      },
    },
    // The one gate into transform_query, shared by both reasons to rewrite.
    rewriteBudget: {
      type: "choice",
      choice: ({ context }) =>
        context.rewrites >= MAX_REWRITES
          ? {
              target: "failed",
              context: {
                failure: `rewrite budget exhausted (MAX_REWRITES=${MAX_REWRITES}) without a useful, grounded answer`,
              },
            }
          : { target: "rewriting" },
    },
    // transform_query: rewrite, then retry the vector store (as LangGraph does).
    rewriting: {
      invoke: {
        src: "rewriteQuestion",
        input: ({ context }) => ({ question: context.question, lastQuery: context.query }),
        onDone: ({ context, output }) => ({
          target: "retrieving",
          context: { query: output.result, rewrites: context.rewrites + 1 },
        }),
        onError: ({ event }) => ({
          target: "failed",
          context: { failure: `rewriteQuestion failed: ${String(event.error)}` },
        }),
      },
    },
    // web_search: results go straight to generate (LangGraph does not grade them).
    searchingWeb: {
      invoke: {
        src: "webSearch",
        input: ({ context }) => ({ query: context.query }),
        onDone: ({ output }) => ({
          target: "generating",
          context: { documents: output },
        }),
        onError: ({ event }) => ({
          target: "failed",
          context: { failure: `webSearch failed: ${String(event.error)}` },
        }),
      },
    },
    generating: {
      invoke: {
        src: "generateAnswer",
        input: ({ context }) => ({ question: context.question, documents: context.documents }),
        onDone: ({ output }) => ({
          target: "checkingGrounding",
          context: { generation: output.result },
        }),
        onError: ({ event }) => ({
          target: "failed",
          context: { failure: `generateAnswer failed: ${String(event.error)}` },
        }),
      },
    },
    // Hallucination grader: "not supported" → regenerate (budget permitting).
    checkingGrounding: {
      invoke: {
        src: "gradeGrounding",
        input: ({ context }) => ({
          documents: context.documents,
          generation: context.generation ?? "",
        }),
        onDone: ({ output }) => ({
          target:
            output.answers.grounded.probability >= GROUNDED_THRESHOLD
              ? "checkingUsefulness"
              : "regenerationBudget",
        }),
        onError: ({ event }) => ({
          target: "failed",
          context: { failure: `gradeGrounding failed: ${String(event.error)}` },
        }),
      },
    },
    regenerationBudget: {
      type: "choice",
      choice: ({ context }) =>
        context.regenerations >= MAX_REGENERATIONS
          ? {
              target: "failed",
              context: {
                failure: `regeneration budget exhausted (MAX_REGENERATIONS=${MAX_REGENERATIONS}); the answer is still not grounded in the documents`,
              },
            }
          : { target: "generating", context: { regenerations: context.regenerations + 1 } },
    },
    // Answer grader: "useful" → END; "not useful" → rewrite (budget permitting).
    checkingUsefulness: {
      invoke: {
        src: "gradeUsefulness",
        input: ({ context }) => ({
          question: context.question,
          generation: context.generation ?? "",
        }),
        onDone: ({ context, output }) =>
          output.answers.useful.probability >= USEFUL_THRESHOLD && context.generation !== null
            ? { target: "done", context: { generation: context.generation } }
            : { target: "rewriteBudget" },
        onError: ({ event }) => ({
          target: "failed",
          context: { failure: `gradeUsefulness failed: ${String(event.error)}` },
        }),
      },
    },
    done: {
      type: "final",
      output: ({ context }) => ({
        answer: context.generation,
        trail: renderTrail(context, true),
        route: context.route,
        documents: context.documents,
        rewrites: context.rewrites,
        regenerations: context.regenerations,
      }),
    },
    // Best-effort terminal: a budget ran out or a call failed. The last draft,
    // if any, is returned clearly marked as unverified.
    failed: {
      type: "final",
      output: ({ context }) => ({
        answer:
          context.generation === null
            ? "Unable to produce a grounded, useful answer for this question."
            : `Unverified (did not pass grading): ${context.generation}`,
        trail: renderTrail(context, false),
        route: context.route,
        documents: context.documents,
        rewrites: context.rewrites,
        regenerations: context.regenerations,
      }),
    },
  },
});

export interface RunAdaptiveRagOptions {
  question?: string;
  /** Injected for tests; direct run supplies a real model executor. */
  generateText?: AgentRequestExecutors["generateText"];
  /** The judge model; tests pass a mock, the direct run uses Jev. */
  judge?: Experimental_EvaluationModel;
  /** Observes each machine transition. */
  onProgress?: (state: string) => void;
}

export interface AdaptiveRagResult {
  answer: string;
  trail: string;
  route: "vectorstore" | "websearch" | null;
  documents: string[];
  rewrites: number;
  regenerations: number;
  /** `done`, or `failed` when a budget ran out or a call failed. */
  finalState: string;
  progress: string[];
}

/** Runs the adaptive RAG flow; records state progress so every branch is observable. */
export async function runAdaptiveRagExample(
  options: RunAdaptiveRagOptions = {},
): Promise<AdaptiveRagResult> {
  const {
    question = "How do LLM agents use long-term memory?",
    generateText,
    judge,
    onProgress,
  } = options;

  const progress: string[] = [];
  const result = await runToQuiescence(
    createAgentRuntime(adaptiveRagMachine, {
      ...(generateText
        ? { executors: { generateText } }
        : { executors: createAiSdkExecutors({ models }) }),
      ...(judge
        ? {
            actors: {
              routeQuestion: createRouteQuestion(judge),
              gradeDocuments: createGradeDocuments(judge),
              gradeGrounding: createGradeGrounding(judge),
              gradeUsefulness: createGradeUsefulness(judge),
            },
          }
        : {}),
      onTransition: (snapshot) => {
        const state = getStatePath(snapshot);
        progress.push(state);
        onProgress?.(state);
      },
    }),
    {
      input: { question },
    },
  );

  if (result.status !== "done") {
    throw new Error(`Adaptive RAG example did not complete: ${result.status}`);
  }
  return { ...result.output, finalState: getStatePath(result.snapshot), progress };
}

// Run directly (`tsx index.ts`); skipped when a test imports this module.
if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  if (!process.env.OPENAI_API_KEY || !process.env.TYPESAFE_AI_API_KEY) {
    console.error("Set OPENAI_API_KEY and TYPESAFE_AI_API_KEY to run this example.");
    process.exit(1);
  }
  void (async () => {
    const { generateText } = createAiSdkExecutors({ models });
    const question = "How do LLM agents use long-term memory?";
    const result = await runAdaptiveRagExample({
      question,
      generateText,
      onProgress: (state) => console.log(`  → ${state}`),
    });

    console.log("\nQuestion:", question);
    console.log("Trail:", result.trail);
    console.log(`\nAnswer (${result.finalState}):`, result.answer);
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
