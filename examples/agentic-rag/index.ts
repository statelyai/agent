/**
 * Agentic RAG — the model decides whether to retrieve at all, and the machine
 * bounds how many times it may.
 *
 * LangGraph's Agentic RAG tutorial gives a chat model one tool, a retriever
 * over Lilian Weng's blog posts. The model either calls the tool or answers
 * directly. Retrieved passages are graded; relevant ones feed a grounded
 * answer, irrelevant ones trigger a question rewrite and another turn for the
 * model.
 *
 * NOTE ON THE RETRIEVER: the tutorial indexes the live blog posts into an
 * in-memory vector store with OpenAI embeddings. This example calls NO
 * network: `retrieve` is a keyword-overlap search over `SAMPLE_POSTS`, five
 * short passages summarizing three of the posts (paraphrased, NOT quoted). Swap
 * the actor for a real retriever and the machine is unchanged.
 *
 * LangGraph shape (tutorials/rag/langgraph_agentic_rag):
 *
 *   START → agent ─ tools_condition ─┬─ END            (answered directly)
 *             ▲                      └─ retrieve → grade_documents ─┬─ generate → END
 *             └──────────── rewrite ◄───────────────────────────────┘
 *
 * Machine shape:
 *
 *   deciding ─┬─ ANSWER → answered? ─┬─ done
 *      ▲      │                      └─ failed   (answer forced by the budget)
 *      │      └─ RETRIEVE (guard: retrievals < MAX_RETRIEVALS)
 *      │            → retrieving ─┬─ grading ─┬─ generating → done
 *      │                          │           │
 *      └──────── rewriting ◄──────┴───────────┘  (nothing found, or graded irrelevant)
 *
 * What maps to what:
 *   - agent + tools_condition → `deciding`: `agent.decide` over the events
 *     `RETRIEVE { keywords }` (the tool call) and `ANSWER { answer }` (no tool
 *     call). The model's choice is a typed machine event, not a message whose
 *     `tool_calls` field a router has to inspect.
 *   - retrieve (ToolNode)    → `retrieving` (keyword actor over the sample posts)
 *   - grade_documents        → `grading` (ONE Jev call, one boolean question per passage),
 *                              its `onDone` choosing generate or rewrite
 *   - rewrite                → `rewriting` (request), then back to `deciding`
 *   - generate               → `generating`
 *
 * Differences from LangGraph worth calling out:
 *   - Grading is a JUDGMENT, not a generation. LangGraph asks a chat model for
 *     one structured yes/no over all passages. Here `grading` calls the AI
 *     SDK's `experimental_evaluate` with Jev (`@ai-sdk/typesafe-ai`) as the
 *     evaluation model: the question and the passages are the state, and each
 *     passage gets its own boolean question ("does it help answer the
 *     question?"). Passages whose probability clears `RELEVANCE_THRESHOLD` are
 *     kept; none kept → rewrite. The RETRIEVE / ANSWER choice stays an
 *     `agent.decide`: it is the model choosing its next move, not a judgment
 *     over evidence.
 *   - The loop is bounded. In LangGraph nothing stops the agent from calling
 *     the retriever forever except `recursion_limit`, which raises an error.
 *     Here `RETRIEVE` is guarded: once `retrievals >= MAX_RETRIEVALS`, the
 *     transition returns `undefined`, the decision is rejected, and the model
 *     is re-asked until it chooses `ANSWER`. That forced answer has no relevant
 *     evidence behind it, so it lands in `failed`, returned as unverified. An
 *     answer the model chose freely (before the budget ran out) lands in `done`.
 *   - A model that keeps choosing RETRIEVE past the budget exhausts the
 *     decision's retries, and `onError` lands in `failed`.
 *   - An empty retrieval skips grading (nothing to grade) and goes straight to
 *     the rewrite.
 *   - Every invoke has an `onError` that lands in `failed`.
 *
 * Dual-mode: `runAgenticRagExample(options?)` takes injectable `generateText`
 * and `decide` executors and a `judge` (tests pass scripted mocks, so CI
 * needs no API key); the direct run uses real models.
 *
 * Run: OPENAI_API_KEY=... TYPESAFE_AI_API_KEY=... npx tsx examples/agentic-rag/index.ts
 */
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { createAsyncLogic } from "xstate";
import { experimental_evaluate as evaluate, type Experimental_EvaluationModel } from "ai";
import { typeSafeAi } from "@ai-sdk/typesafe-ai";
import { createAiSdkExecutors } from "@statelyai/agent/ai-sdk";
import { getStatePath, runAgent, setupAgent, type AgentRequestExecutors } from "@statelyai/agent";

const models = {
  rag: openai("gpt-6-luna"),
};

/**
 * The judge: TypeSafe's Jev through the AI SDK's evaluation-model provider.
 * Reads `TYPESAFE_AI_API_KEY`. Tests pass a mock evaluation model instead.
 */
const judgeModel: Experimental_EvaluationModel = typeSafeAi.evaluationModel("jev-latest");

/** Retrievals the model may make per run. Past it, RETRIEVE is rejected. */
export const MAX_RETRIEVALS = 3;

/**
 * Sample data: the retriever's index. Short paraphrased summaries of three of
 * Lilian Weng's posts, the corpus the tutorial indexes. Only `text` is
 * searched; `source` is attribution.
 */
export const SAMPLE_POSTS: Array<{ id: string; source: string; text: string }> = [
  {
    id: "agents-overview",
    source: "LLM Powered Autonomous Agents (2023)",
    text: "An LLM-powered autonomous agent pairs the LLM as its core controller with three components: planning, memory, and tool use.",
  },
  {
    id: "agents-memory",
    source: "LLM Powered Autonomous Agents (2023)",
    text: "Agent memory types mirror human memory: sensory memory as embeddings of raw inputs, short-term memory as in-context learning, and long-term memory as an external vector store queried with fast nearest-neighbor search.",
  },
  {
    id: "agents-planning",
    source: "LLM Powered Autonomous Agents (2023)",
    text: "Planning covers task decomposition into subgoals and self-reflection, where the agent critiques past actions and refines later steps.",
  },
  {
    id: "prompt-engineering",
    source: "Prompt Engineering (2023)",
    text: "Prompt engineering steers an LLM without changing its weights: zero-shot and few-shot prompting, instruction prompting, and step-by-step reasoning prompts.",
  },
  {
    id: "adversarial-attacks",
    source: "Adversarial Attacks on LLMs (2023)",
    text: "Adversarial attacks on LLMs include jailbreak prompts, token manipulation, and gradient-based attacks that search for inputs which bypass safety training.",
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

/** A passage is kept when Jev's probability that it helps clears this. */
export const RELEVANCE_THRESHOLD = 0.5;

/**
 * grade_documents as a judgment: the question and every retrieved passage are
 * the state, and each passage gets its own boolean question, all in one
 * `experimental_evaluate` call. The judge model is injected by tests and
 * hosts; the default is Jev.
 */
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
              true: "The passage states facts the answer would be built from.",
              false: "The passage is off-topic, or only shares vocabulary with the question.",
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

/** Numbered document list for prompts. */
function renderDocuments(documents: string[]): string {
  return documents.map((doc, i) => `[${i + 1}] ${doc}`).join("\n");
}

const agenticRagContextSchema = z.object({
  question: z.string(),
  // The question the model is currently working on: the original, then each
  // rewrite of it.
  currentQuestion: z.string(),
  // Relevant passages only: cleared when a retrieval is graded irrelevant.
  documents: z.array(z.string()),
  // The search keywords the model sent with its last RETRIEVE.
  lastKeywords: z.string().nullable(),
  retrievals: z.number(),
  rewrites: z.number(),
  answer: z.string().nullable(),
  // Why the run stopped short; set only on the way into `failed`.
  failure: z.string().nullable(),
});

type AgenticRagContext = z.infer<typeof agenticRagContextSchema>;

/** The plain-language trail, rendered from the counters in context. */
function renderTrail(context: AgenticRagContext, verified: boolean): string {
  const parts: string[] = [];
  if (context.retrievals === 0) {
    parts.push(
      verified
        ? "The model answered directly, without calling the retriever."
        : "The retriever was never called.",
    );
  } else {
    parts.push(
      `The model called the retriever ${context.retrievals} of ${MAX_RETRIEVALS} allowed time(s).`,
    );
    if (context.rewrites > 0) parts.push(`Rewrote the question ${context.rewrites} time(s).`);
    if (context.documents.length > 0) {
      parts.push(`Answered from ${context.documents.length} passage(s) graded relevant.`);
    } else {
      parts.push("No retrieved passage was graded relevant.");
      if (verified) parts.push("The model then chose to answer without them.");
    }
  }
  if (!verified) parts.push(`Stopped: ${context.failure ?? "unknown failure"}.`);
  return parts.join(" ");
}

const agentSetup = setupAgent({
  models,
  context: agenticRagContextSchema,
  input: z.object({
    question: z.string(),
  }),
  output: z.object({
    answer: z.string(),
    trail: z.string(),
    retrievals: z.number(),
    rewrites: z.number(),
    answeredDirectly: z.boolean(),
  }),
  events: {
    /** Model: call the retriever tool with these search keywords. */
    RETRIEVE: z.object({ keywords: z.string() }),
    /** Model: answer now, without (further) retrieval. */
    ANSWER: z.object({ answer: z.string() }),
  },
  // `done` is reached from `generating` or `answered`, both of which set `answer`.
  states: {
    done: {
      schemas: { context: agenticRagContextSchema.extend({ answer: z.string() }) },
    },
  },
  actors: {
    // grade_documents: a Jev judgment per passage (see createGradeDocuments).
    gradeDocuments: createGradeDocuments(),
    // The retriever tool: keyword search over the sample posts. Top 2.
    retrieve: createAsyncLogic<string[], { keywords: string }>({
      run: async ({ input }) =>
        SAMPLE_POSTS.map((post) => ({ post, score: scoreDocument(input.keywords, post.text) }))
          .filter((scored) => scored.score > 0)
          .sort((left, right) => right.score - left.score)
          .slice(0, 2)
          .map(({ post }) => `[sample post: ${post.source}] ${post.text}`),
    }),
  },
  requests: {
    // rewrite: reason about the intent and produce a better question.
    rewriteQuestion: {
      schemas: {
        input: z.object({ question: z.string(), lastKeywords: z.string() }),
        output: z.string(),
      },
      model: "rag",
      system:
        "The last search found nothing relevant. Look at the question's underlying " +
        "intent and rewrite it as an improved question. Return only the new question.",
      prompt: ({ input }) =>
        [
          `Original question: ${input.question}`,
          `Keywords that found nothing relevant: ${input.lastKeywords}`,
        ].join("\n"),
    },
    // generate: grounded answer over the relevant passages.
    generateAnswer: {
      schemas: {
        input: z.object({ question: z.string(), documents: z.array(z.string()) }),
        output: z.string(),
      },
      model: "rag",
      system:
        "Answer the question using ONLY the retrieved passages. If they do not contain " +
        "the answer, say so. Use three sentences at most.",
      prompt: ({ input }) =>
        [`Question: ${input.question}`, "", "Passages:", renderDocuments(input.documents)].join(
          "\n",
        ),
    },
  },
});

export const agenticRagSchemas = agentSetup.schemas;

export const agenticRagMachine = agentSetup.createMachine({
  id: "agentic-rag",
  context: ({ input }) => ({
    question: input.question,
    currentQuestion: input.question,
    documents: [],
    lastKeywords: null,
    retrievals: 0,
    rewrites: 0,
    answer: null,
    failure: null,
  }),
  initial: "deciding",
  states: {
    // agent + tools_condition: the model picks RETRIEVE or ANSWER.
    deciding: {
      invoke: {
        src: "agent.decide",
        input: ({ context }) => ({
          model: "rag",
          name: "chooseAction",
          system:
            "You answer questions. You have one tool: RETRIEVE searches Lilian Weng's blog " +
            "posts on LLM agents, prompt engineering, and adversarial attacks on LLMs. " +
            "Choose RETRIEVE (with search keywords) when the question needs those posts. " +
            "Choose ANSWER when it does not (arithmetic, small talk, general knowledge), " +
            "or when you already know enough.",
          prompt: [
            `Question: ${context.currentQuestion}`,
            context.rewrites > 0 ? `(Rewritten from: ${context.question})` : "",
            `Retrievals used: ${context.retrievals} of ${MAX_RETRIEVALS}.`,
            context.retrievals > 0
              ? "The last retrieval found nothing relevant, so the question was rewritten."
              : "",
            context.retrievals >= MAX_RETRIEVALS
              ? "The retrieval budget is spent. You must ANSWER now."
              : "Choose RETRIEVE or ANSWER.",
          ]
            .filter(Boolean)
            .join("\n"),
          allowedEvents: ["RETRIEVE", "ANSWER"],
          maxRetries: 2,
        }),
        // Retries exhausted (e.g. the model insists on RETRIEVE past the budget).
        onError: ({ event }) => ({
          target: "failed",
          context: { failure: `chooseAction failed: ${String(event.error)}` },
        }),
      },
      on: {
        // Guard: illegal once the budget is spent. The rejected choice is fed
        // back to the model, which must then ANSWER.
        RETRIEVE: ({ context, event }) =>
          context.retrievals < MAX_RETRIEVALS
            ? {
                target: "retrieving",
                context: { retrievals: context.retrievals + 1, lastKeywords: event.keywords },
              }
            : undefined,
        ANSWER: ({ event }) => ({ target: "answered", context: { answer: event.answer } }),
      },
    },
    // Was the answer the model's free choice, or forced by the spent budget?
    answered: {
      type: "choice",
      choice: ({ context }) =>
        context.retrievals >= MAX_RETRIEVALS || context.answer === null
          ? {
              target: "failed",
              context: {
                failure: `retrieval budget exhausted (MAX_RETRIEVALS=${MAX_RETRIEVALS}) without finding relevant passages`,
              },
            }
          : { target: "done", context: { answer: context.answer } },
    },
    retrieving: {
      invoke: {
        src: "retrieve",
        input: ({ context }) => ({ keywords: context.lastKeywords ?? context.currentQuestion }),
        onDone: ({ output }) => ({
          target: output.length > 0 ? "grading" : "rewriting",
          context: { documents: output },
        }),
        onError: ({ event }) => ({
          target: "failed",
          context: { failure: `retrieve failed: ${String(event.error)}` },
        }),
      },
    },
    // grade_documents: keep the passages that clear the threshold; any kept →
    // generate, none → rewrite.
    grading: {
      invoke: {
        src: "gradeDocuments",
        input: ({ context }) => ({ question: context.question, documents: context.documents }),
        onDone: ({ context, output }) => {
          const relevant = context.documents.filter(
            (_doc, i) => (output.answers[`doc${i}`]?.probability ?? 0) >= RELEVANCE_THRESHOLD,
          );
          return relevant.length > 0
            ? { target: "generating", context: { documents: relevant } }
            : { target: "rewriting", context: { documents: [] } };
        },
        onError: ({ event }) => ({
          target: "failed",
          context: { failure: `gradeDocuments failed: ${String(event.error)}` },
        }),
      },
    },
    // rewrite: a better question, then the model gets another turn.
    rewriting: {
      invoke: {
        src: "rewriteQuestion",
        input: ({ context }) => ({
          question: context.question,
          lastKeywords: context.lastKeywords ?? context.currentQuestion,
        }),
        onDone: ({ context, output }) => ({
          target: "deciding",
          context: { currentQuestion: output.result, rewrites: context.rewrites + 1 },
        }),
        onError: ({ event }) => ({
          target: "failed",
          context: { failure: `rewriteQuestion failed: ${String(event.error)}` },
        }),
      },
    },
    generating: {
      invoke: {
        src: "generateAnswer",
        input: ({ context }) => ({ question: context.question, documents: context.documents }),
        onDone: ({ output }) => ({ target: "done", context: { answer: output.result } }),
        onError: ({ event }) => ({
          target: "failed",
          context: { failure: `generateAnswer failed: ${String(event.error)}` },
        }),
      },
    },
    done: {
      type: "final",
      output: ({ context }) => ({
        answer: context.answer,
        trail: renderTrail(context, true),
        retrievals: context.retrievals,
        rewrites: context.rewrites,
        answeredDirectly: context.retrievals === 0,
      }),
    },
    // Best-effort terminal: the budget forced an unsupported answer, or a call
    // failed. Any answer the model gave is returned clearly marked.
    failed: {
      type: "final",
      output: ({ context }) => ({
        answer:
          context.answer === null
            ? "Unable to answer this question from the retrieved passages."
            : `Unverified (no relevant passages found): ${context.answer}`,
        trail: renderTrail(context, false),
        retrievals: context.retrievals,
        rewrites: context.rewrites,
        answeredDirectly: false,
      }),
    },
  },
});

export interface RunAgenticRagOptions {
  question?: string;
  /** Injected for tests; direct run supplies real model executors. */
  generateText?: AgentRequestExecutors["generateText"];
  decide?: AgentRequestExecutors["decide"];
  /** The judge model; tests pass a mock, the direct run uses Jev. */
  judge?: Experimental_EvaluationModel;
  /** Observes each machine transition. */
  onProgress?: (state: string) => void;
}

export interface AgenticRagResult {
  answer: string;
  trail: string;
  retrievals: number;
  rewrites: number;
  answeredDirectly: boolean;
  /** `done`, or `failed` when the budget forced an answer or a call failed. */
  finalState: string;
  progress: string[];
}

/** Runs the agentic RAG flow; records state progress so the model's route is observable. */
export async function runAgenticRagExample(
  options: RunAgenticRagOptions = {},
): Promise<AgenticRagResult> {
  const {
    question = "What does Lilian Weng say about the types of agent memory?",
    generateText,
    decide,
    judge,
    onProgress,
  } = options;

  const executors =
    generateText || decide ? { generateText, decide } : createAiSdkExecutors({ models });
  const progress: string[] = [];
  const result = await runAgent(agenticRagMachine, {
    input: { question },
    executors,
    ...(judge ? { actors: { gradeDocuments: createGradeDocuments(judge) } } : {}),
    onTransition: (snapshot) => {
      const state = getStatePath(snapshot);
      progress.push(state);
      onProgress?.(state);
    },
  });

  if (result.status !== "done") {
    throw new Error(`Agentic RAG example did not complete: ${result.status}`);
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
    const { generateText, decide } = createAiSdkExecutors({ models });
    const question = "What does Lilian Weng say about the types of agent memory?";
    const result = await runAgenticRagExample({
      question,
      generateText,
      decide,
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
