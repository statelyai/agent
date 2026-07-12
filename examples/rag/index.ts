/**
 * Retrieval-augmented generation (RAG): retrieve → answer, grounded on a small
 * in-file corpus, with conversational memory accumulating in machine context.
 *
 * Demonstrates:
 *   - Retrieval as a typed plain actor (`retrieve`) — no LLM, no fake embeddings
 *     API. It does honest keyword-overlap scoring over a sample corpus and
 *     returns the top documents. (Real systems swap this for a vector store;
 *     the machine shape is identical.)
 *   - A grounded answer request: the model only sees the retrieved docs and is
 *     told to answer from them.
 *   - Conversational context: `memory` accumulates each question and answer in
 *     context across turns, so the machine carries its own chat history.
 *
 * The `generateText` executor is injectable so tests can drive the machine with
 * a mock; on direct run it uses a real model.
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/rag/index.ts
 */
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { createAsyncLogic } from "xstate";
import { defineModels } from "../../src/ai-sdk/index.js";
import { runAgent, setupAgent, type AgentRequestExecutors } from "../../src/index.js";
import { runExampleMain } from "../helpers/main.js";

export const models = defineModels({
  answerer: openai("gpt-5.4-mini"),
});

/**
 * Sample data: a tiny in-file corpus about XState / state machines. Stand-in
 * for a real document store — replace `retrieve` with a vector search over
 * your own corpus and the rest of the machine is unchanged.
 */
export const SAMPLE_CORPUS: Array<{ id: string; text: string }> = [
  {
    id: "states",
    text: "A state machine is in exactly one of a finite set of states at a time. Transitions move it between states in response to events.",
  },
  {
    id: "context",
    text: "Context is the extended, quantitative state of a machine — arbitrary data stored alongside the finite state and updated by assign actions.",
  },
  {
    id: "actors",
    text: "An actor is a running unit of behavior that can receive events, send events, and spawn other actors. Machines are one kind of actor logic.",
  },
  {
    id: "invoke",
    text: "Invoking an actor starts it when a state is entered and stops it when the state is exited. onDone and onError transitions handle its result.",
  },
  {
    id: "guards",
    text: "A guard is a condition that must be true for a transition to be taken. Guards keep illegal transitions out of the machine.",
  },
  {
    id: "final",
    text: "A final state signals that the machine (or a region) is done. A top-level final state produces the machine output.",
  },
  {
    id: "agents",
    text: "Agents combine state machines with language models: model calls are actors invoked from states, so the control flow stays inspectable.",
  },
];

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
]);

/** Honest keyword-overlap scoring — NOT embeddings. Counts shared content words. */
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
    if (haystack.includes(term)) {
      score += 1;
    }
  }
  return score;
}

const ragContextSchema = z.object({
  question: z.string(),
  documents: z.array(z.string()),
  answer: z.string().nullable(),
  memory: z.array(z.string()),
});

const agentSetup = setupAgent({
  models,
  context: ragContextSchema,
  input: z.object({
    question: z.string(),
    memory: z.array(z.string()).default([]),
  }),
  output: z.object({
    answer: z.string(),
    documents: z.array(z.string()),
    memory: z.array(z.string()),
  }),
  // answering always sets `answer` before `done` reads it — narrow it non-null there.
  states: {
    retrieving: {},
    answering: {},
    done: {
      schemas: { context: ragContextSchema.extend({ answer: z.string() }) },
    },
  },
  actorSources: {
    // Typed plain actor: keyword retrieval over the sample corpus. Top 3 docs.
    retrieve: createAsyncLogic<string[], { question: string }>({
      run: async ({ input }) =>
        SAMPLE_CORPUS.map((doc) => ({
          text: doc.text,
          score: scoreDocument(input.question, doc.text),
        }))
          .filter((scored) => scored.score > 0)
          .sort((left, right) => right.score - left.score)
          .slice(0, 3)
          .map((scored) => scored.text),
    }),
  },
  requests: {
    answerQuestion: {
      schemas: {
        input: z.object({
          question: z.string(),
          documents: z.array(z.string()),
          memory: z.array(z.string()),
        }),
        output: z.string(),
      },
      model: "answerer",
      system:
        "Answer the question using ONLY the provided documents. If the " +
        "documents do not contain the answer, say so. Be concise.",
      prompt: ({ input }) =>
        [
          input.memory.length ? `Conversation so far:\n${input.memory.join("\n")}\n` : "",
          `Documents:\n${input.documents.map((doc, i) => `[${i + 1}] ${doc}`).join("\n")}`,
          `\nQuestion: ${input.question}`,
        ].join("\n"),
    },
  },
});

export const ragMachine = agentSetup.createMachine({
  id: "rag",
  context: ({ input }) => ({
    question: input.question,
    documents: [],
    answer: null,
    memory: input.memory,
  }),
  initial: "retrieving",
  states: {
    retrieving: {
      invoke: {
        src: "retrieve",
        input: ({ context }) => ({ question: context.question }),
        onDone: ({ output }) => ({
          target: "answering",
          context: { documents: output },
        }),
      },
    },
    answering: {
      invoke: {
        src: "answerQuestion",
        input: ({ context }) => ({
          question: context.question,
          documents: context.documents,
          memory: context.memory,
        }),
        onDone: ({ context, output }) => ({
          target: "done",
          context: {
            answer: output,
            // Accumulate conversational memory across turns.
            memory: [...context.memory, `Q: ${context.question}`, `A: ${output}`],
          },
        }),
      },
    },
    done: {
      type: "final",
      output: ({ context }) => ({
        answer: context.answer,
        documents: context.documents,
        memory: context.memory,
      }),
    },
  },
});

export interface RunRAGOptions {
  question?: string;
  memory?: string[];
  /** Injected for tests; direct run supplies a real model executor. */
  generateText?: AgentRequestExecutors["generateText"];
  /** Direct run passes this to narrate state; tests leave it undefined (quiet). */
  onTransition?: (snapshot: { value: unknown }) => void;
}

export interface RAGResult {
  answer: string;
  documents: string[];
  memory: string[];
}

/** Retrieves against the sample corpus and answers grounded on the results. */
export async function runRAGExample(options: RunRAGOptions = {}): Promise<RAGResult> {
  const {
    question = "What is context in a state machine?",
    memory = [],
    generateText,
    onTransition,
  } = options;

  const result = await runAgent(ragMachine, {
    input: { question, memory },
    ...(generateText ? { generateText } : {}),
    ...(onTransition ? { onTransition } : {}),
  });

  if (result.status !== "done") {
    throw new Error(`RAG example did not complete: ${result.status}`);
  }
  return result.output;
}

runExampleMain(import.meta.url, async () => {
  const { createAiSdkExecutors } = await import("../../src/ai-sdk/index.js");
  const { generateText } = createAiSdkExecutors({ models });

  const question = "What is context in a state machine?";
  const result = await runRAGExample({
    question,
    generateText,
    onTransition: (snapshot) => console.log("[state]", JSON.stringify(snapshot.value)),
  });

  console.log("Question:", question);
  console.log("\nRetrieved documents:");
  result.documents.forEach((doc, i) => console.log(`  [${i + 1}] ${doc}`));
  console.log("\nGrounded answer:", result.answer);
});
