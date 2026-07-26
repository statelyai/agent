/**
 * Adaptive RAG — route each question to local retrieval or web search, grade
 * the evidence, rewrite weak queries, then verify the generated answer.
 *
 * Ported from LangGraph's adaptive-RAG graph. Provider integrations are tiny
 * in-memory actors so the control flow stays runnable and testable.
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/adaptive-rag/index.ts
 */
import { openai } from "@ai-sdk/openai";
import { createAsyncLogic } from "xstate";
import { z } from "zod";
import { runAgent, setupAgent, type AgentRequestExecutors } from "@statelyai/agent";
import { createAiSdkExecutors, defineModels } from "@statelyai/agent/ai-sdk";

const routeSchema = z.enum(["local", "web"]);

export const models = defineModels({
  router: openai("gpt-5.4-mini"),
  grader: openai("gpt-5.4-mini"),
  writer: openai("gpt-5.4-mini"),
});

const corpus = [
  "XState actors persist as JSON-safe snapshots and resume from explicit events.",
  "State machines make retries, human approval, and failure paths visible.",
  "Agent requests separate portable workflow logic from host-owned model execution.",
];

const webIndex = [
  "The current weather in Lisbon is mild with coastal winds.",
  "Recent TypeScript releases improve inference and language-service performance.",
];

function search(items: string[], query: string) {
  const words = query
    .toLowerCase()
    .split(/\W+/)
    .filter((word) => word.length > 3);
  return items.filter((item) => words.some((word) => item.toLowerCase().includes(word)));
}

const setup = setupAgent({
  models,
  context: z.object({
    question: z.string(),
    query: z.string(),
    route: routeSchema.nullable(),
    documents: z.array(z.string()),
    answer: z.string().nullable(),
    retries: z.number(),
  }),
  input: z.object({ question: z.string() }),
  output: z.object({
    route: routeSchema,
    query: z.string(),
    documents: z.array(z.string()),
    answer: z.string(),
    retries: z.number(),
  }),
  actorSources: {
    retrieve: createAsyncLogic<string[], { query: string }>({
      run: async ({ input }) => search(corpus, input.query),
    }),
    webSearch: createAsyncLogic<string[], { query: string }>({
      run: async ({ input }) => search(webIndex, input.query).map((text) => `[web] ${text}`),
    }),
  },
  requests: {
    routeQuestion: {
      schemas: {
        input: z.object({ question: z.string() }),
        output: z.object({ route: routeSchema }),
      },
      model: "router",
      system:
        "Route questions about XState, agents, or durable workflows to local. Route current events, weather, and recent information to web.",
      prompt: ({ input }) => input.question,
    },
    gradeEvidence: {
      schemas: {
        input: z.object({ question: z.string(), documents: z.array(z.string()) }),
        output: z.object({ relevant: z.boolean() }),
      },
      model: "grader",
      system: "Decide whether the evidence can answer the question.",
      prompt: ({ input }) =>
        `Question: ${input.question}\nEvidence:\n${input.documents.join("\n")}`,
    },
    rewriteQuery: {
      schemas: { input: z.object({ question: z.string() }), output: z.string() },
      model: "writer",
      system: "Rewrite the question as a concise retrieval query.",
      prompt: ({ input }) => input.question,
    },
    generateAnswer: {
      schemas: {
        input: z.object({ question: z.string(), documents: z.array(z.string()) }),
        output: z.string(),
      },
      model: "writer",
      system: "Answer only from the supplied evidence.",
      prompt: ({ input }) =>
        `Question: ${input.question}\nEvidence:\n${input.documents.join("\n")}`,
    },
    gradeAnswer: {
      schemas: {
        input: z.object({ question: z.string(), answer: z.string() }),
        output: z.object({ grounded: z.boolean(), useful: z.boolean() }),
      },
      model: "grader",
      system: "Judge whether the answer is grounded and useful.",
      prompt: ({ input }) => `Question: ${input.question}\nAnswer: ${input.answer}`,
    },
  },
});

export const adaptiveRagMachine = setup.createMachine({
  id: "adaptive-rag",
  context: ({ input }) => ({
    question: input.question,
    query: input.question,
    route: null,
    documents: [],
    answer: null,
    retries: 0,
  }),
  output: ({ context }) => ({
    route: context.route ?? "local",
    query: context.query,
    documents: context.documents,
    answer: context.answer ?? "",
    retries: context.retries,
  }),
  initial: "routing",
  states: {
    routing: {
      invoke: {
        src: "routeQuestion",
        input: ({ context }) => ({ question: context.question }),
        onDone: ({ output }) => ({ target: "dispatch", context: { route: output.route } }),
      },
    },
    dispatch: {
      type: "choice",
      choice: ({ context }) => ({ target: context.route ?? "local" }),
    },
    local: {
      invoke: {
        src: "retrieve",
        input: ({ context }) => ({ query: context.query }),
        onDone: ({ output }) => ({ target: "gradingEvidence", context: { documents: output } }),
      },
    },
    web: {
      invoke: {
        src: "webSearch",
        input: ({ context }) => ({ query: context.query }),
        onDone: ({ output }) => ({ target: "generating", context: { documents: output } }),
      },
    },
    gradingEvidence: {
      invoke: {
        src: "gradeEvidence",
        input: ({ context }) => ({ question: context.question, documents: context.documents }),
        onDone: ({ output, context }) => ({
          target: output.relevant || context.retries >= 1 ? "generating" : "rewriting",
        }),
      },
    },
    rewriting: {
      invoke: {
        src: "rewriteQuery",
        input: ({ context }) => ({ question: context.question }),
        // Return to the datasource the router originally picked; a rewrite must
        // not silently switch a web-routed question to local retrieval.
        onDone: ({ output, context }) => ({
          target: context.route === "web" ? "web" : "local",
          context: { query: output, retries: context.retries + 1 },
        }),
      },
    },
    generating: {
      invoke: {
        src: "generateAnswer",
        input: ({ context }) => ({ question: context.question, documents: context.documents }),
        onDone: ({ output }) => ({ target: "gradingAnswer", context: { answer: output } }),
      },
    },
    gradingAnswer: {
      invoke: {
        src: "gradeAnswer",
        input: ({ context }) => ({ question: context.question, answer: context.answer ?? "" }),
        onDone: ({ output, context }) => ({
          target:
            output.grounded && output.useful ? "done" : context.retries >= 1 ? "done" : "rewriting",
        }),
      },
    },
    done: { type: "final" },
  },
});

export interface RunAdaptiveRagOptions {
  question?: string;
  /** Injected for tests; direct run supplies a real model executor. */
  generateText?: AgentRequestExecutors["generateText"];
  /** Observes each machine transition. */
  onProgress?: (state: string) => void;
}

export async function runAdaptiveRagExample(options: RunAdaptiveRagOptions = {}) {
  const { question = "How do durable agent workflows resume?", generateText, onProgress } = options;
  const result = await runAgent(adaptiveRagMachine, {
    input: { question },
    ...(generateText
      ? { executors: { generateText } }
      : { executors: createAiSdkExecutors({ models }) }),
    ...(onProgress ? { onTransition: (snapshot) => onProgress(String(snapshot.value)) } : {}),
  });
  if (result.status !== "done") throw new Error(`Adaptive RAG did not complete: ${result.status}`);
  return result.output;
}

if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  if (!process.env.OPENAI_API_KEY) throw new Error("Set OPENAI_API_KEY to run this example.");
  void runAdaptiveRagExample().then(console.log);
}
