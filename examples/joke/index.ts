/**
 * Streaming joke agent with a machine-owned feedback loop.
 *
 * Demonstrates:
 *   - `mode: 'stream'` text logic: the joke streams token-by-token.
 *   - `agent.userInput`: the machine asks the human for feedback, and loops
 *     back to tell another joke until the feedback reads as "done".
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/joke/index.ts
 */
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { type LanguageModel } from "ai";
import { createAiSdkExecutors } from "../../src/ai-sdk/index.js";
import { createAgentSchemas, createTextLogic, runAgent, setupAgent } from "../../src/index.js";

const jokeSchema = z.object({
  joke: z.string(),
});

const schemas = createAgentSchemas({
  context: z.object({
    topic: z.string(),
    joke: z.string().nullable(),
    feedback: z.string().nullable(),
  }),
  input: z.object({ topic: z.string() }),
  output: jokeSchema,
});

// Annotated with LanguageModel so the exported const has a portable, nameable
// type (TS2742); model-ref keys are inferred from this map regardless.
export const models: Record<"jokeWriter", LanguageModel> = {
  jokeWriter: openai("gpt-5.4-mini"),
} as const;

export const tellJoke = createTextLogic({
  mode: "stream",
  schemas: {
    input: z.object({ topic: z.string() }),
    output: z.string(),
  },
  model: "jokeWriter",
  system: "You tell short, punchy jokes.",
  prompt: ({ input }) => `Tell a joke about ${input.topic}.`,
});

export const jokeActors = {
  tellJoke,
};

const jokeAgent = setupAgent({
  schemas,
  models,
  actorSources: jokeActors,
});

export const jokeSchemas = schemas;

export const jokeMachine = jokeAgent.createMachine({
  id: "joke-streamer",
  context: ({ input }) => ({ topic: input.topic, joke: null, feedback: null }),
  output: ({ context }) => ({ joke: context.joke ?? "" }),
  initial: "streaming",
  states: {
    streaming: {
      invoke: {
        id: "joke",
        src: "tellJoke",
        input: ({ context }) => ({ topic: context.topic }),
        onDone: ({ output }) => ({
          target: "reviewing",
          context: { joke: output },
        }),
      },
    },
    reviewing: {
      invoke: {
        id: "jokeFeedback",
        src: "agent.userInput",
        input: ({ context }) => ({
          prompt: `How was this joke? ${context.joke ?? ""}`,
          schema: z.object({ feedback: z.string() }),
        }),
        onDone: ({ event }) => ({
          target: "checkingFeedback",
          // `agent.userInput`'s output is `unknown`: xstate derives a named
          // invoke's onDone output from the *registered* actor's output type
          // (`OutputFrom<TActorMap['agent.userInput']>`), which can't depend on
          // this invoke's per-call `input.schema`. So the schema still validates
          // the answer at runtime, but the type needs a cast here.
          context: {
            feedback: (event.output as { feedback?: string }).feedback ?? "",
          },
        }),
      },
    },
    checkingFeedback: {
      type: "choice",
      choice: ({ context }) =>
        /\b(done|stop|enough|no more|finished|quit|ok(?:ay)?\b.*\bdone)\b/i.test(
          context.feedback ?? "",
        )
          ? { target: "done" }
          : { target: "streaming" },
    },
    done: { type: "final" },
  },
});

const executors = createAiSdkExecutors({ models });

async function promptFeedback(question: string): Promise<string> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(`\n${question}\n(reply, or say "done" to stop) > `);
  } finally {
    rl.close();
  }
}

export async function main() {
  const result = await runAgent(jokeMachine, {
    input: { topic: "state machines" },
    ...executors,
    // The machine drives the loop; the host only answers `agent.userInput`.
    userInput: async ({ prompt }) => ({
      feedback: await promptFeedback(prompt ?? "How was that?"),
    }),
    onChunk: (chunk) => process.stdout.write(chunk),
  });

  if (result.status !== "done") {
    throw new Error(`Joke agent did not complete: ${result.status}`);
  }
  console.log(`\n\nFinal joke: ${result.output.joke}`);
}

if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  if (!process.env.OPENAI_API_KEY) {
    console.error("Set OPENAI_API_KEY to run this example.");
    process.exit(1);
  }
  void main();
}
