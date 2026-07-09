/**
 * Joke teller — a machine-owned tell → rate → decide loop, ported from the v1
 * `joke-teller` example.
 *
 * Flow: get a topic from the user → stream a joke about it → rate it 1-10 with
 * an explanation → let the model DECIDE (not a regex) whether to tell another
 * joke or stop. The decision is an `agent.decide` invoke whose `allowedEvents`
 * are the machine's own loop-control events, so the state machine owns the loop.
 *
 * Dual-mode: `runAgent` takes host executors, so the same machine runs live
 * against real models (readline topic, streaming to stdout) or against mocked
 * executors in tests. See index.test.ts.
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/joke/index.ts
 */
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { type LanguageModel } from "ai";
import { createAiSdkExecutors } from "../../src/ai-sdk/index.js";
import { promptLine } from "../helpers/cli.js";
import {
  createAgentSchemas,
  createTextLogic,
  runAgent,
  sendDecision,
  setupAgent,
} from "../../src/index.js";

const DEFAULT_TOPIC = "state machines";

const ratingSchema = z.object({
  rating: z.number().min(1).max(10),
  explanation: z.string(),
});

const funnyPhrases = [
  "Concocting chuckles...",
  "Brewing belly laughs...",
  "Fabricating funnies...",
  "Whipping up wisecracks...",
  "Hatching howlers...",
];
const ratingPhrases = [
  "Assessing amusement...",
  "Evaluating hilarity...",
  "Judging jollity...",
  "Measuring merriment...",
];
const pick = (phrases: string[]) => phrases[Math.floor(Math.random() * phrases.length)]!;

export const jokeSchemas = createAgentSchemas({
  context: z.object({
    topic: z.string(),
    jokes: z.array(z.string()),
    lastRating: z.number().nullable(),
    lastExplanation: z.string().nullable(),
  }),
  input: z.object({ topic: z.string().default(DEFAULT_TOPIC) }),
  output: z.object({
    topic: z.string(),
    jokes: z.array(z.string()),
    lastRating: z.number().nullable(),
  }),
  events: {
    // Loop-control events the model chooses between in `deciding`.
    TELL_ANOTHER: z.object({}),
    END: z.object({}),
  },
});

// Annotated with LanguageModel so the exported const has a portable, nameable
// type (TS2742); model-ref keys are inferred from this map regardless.
export const models: Record<"jokeWriter" | "critic", LanguageModel> = {
  jokeWriter: openai("gpt-5.4-mini"),
  critic: openai("gpt-5.4-mini"),
} as const;

export const tellJoke = createTextLogic({
  mode: "stream",
  schemas: {
    input: z.object({ topic: z.string() }),
    output: z.string(),
  },
  model: "jokeWriter",
  system: "You tell short, punchy jokes. Stay on topic.",
  prompt: ({ input }) => `Tell a joke about ${input.topic}.`,
});

export const rateJoke = createTextLogic({
  schemas: {
    input: z.object({ joke: z.string() }),
    output: ratingSchema,
  },
  model: "critic",
  system: "You rate jokes on a scale of 1 to 10 and briefly explain the score.",
  prompt: ({ input }) => `Rate this joke from 1 to 10:\n\n${input.joke}`,
});

export const jokeActors = { tellJoke, rateJoke };

const jokeAgentSetup = setupAgent({
  schemas: jokeSchemas,
  models,
  actorSources: jokeActors,
});

const DECIDE_SYSTEM =
  "You decide whether a joke-teller keeps going. If the last joke rated 7 or " +
  "higher it was good enough — END. Otherwise TELL_ANOTHER to try again.";

export const jokeMachine = jokeAgentSetup.createMachine({
  id: "joke-teller",
  context: ({ input }) => ({
    topic: input.topic,
    jokes: [],
    lastRating: null,
    lastExplanation: null,
  }),
  initial: "telling",
  states: {
    telling: {
      invoke: {
        id: "tellJoke",
        src: "tellJoke",
        input: ({ context }) => ({ topic: context.topic }),
        onDone: ({ context, output }) => ({
          target: "rating",
          context: { jokes: [...context.jokes, output] },
        }),
      },
    },
    rating: {
      invoke: {
        id: "rateJoke",
        src: "rateJoke",
        input: ({ context }) => ({ joke: context.jokes.at(-1) ?? "" }),
        onDone: ({ output }) => ({
          target: "deciding",
          context: {
            lastRating: output.rating,
            lastExplanation: output.explanation,
          },
        }),
      },
    },
    deciding: {
      invoke: {
        id: "decideNext",
        src: "agent.decide",
        input: ({ context }) => ({
          model: "critic",
          system: DECIDE_SYSTEM,
          prompt: [
            `Last joke rating: ${context.lastRating}`,
            `Explanation: ${context.lastExplanation ?? ""}`,
            "Choose TELL_ANOTHER or END.",
          ].join("\n"),
          // Typo'd event names are caught at compile time — allowedEvents is
          // typed against the machine's event-schema keys.
          allowedEvents: ["TELL_ANOTHER", "END"] as const,
          maxRetries: 2,
        }),
        onDone: sendDecision(),
        onError: { target: "done" },
      },
      on: {
        TELL_ANOTHER: { target: "telling" },
        END: { target: "done" },
      },
    },
    done: {
      type: "final",
      output: ({ context }) => ({
        topic: context.topic,
        jokes: context.jokes,
        lastRating: context.lastRating,
      }),
    },
  },
});

async function promptTopic(): Promise<string> {
  return (await promptLine("Give me a joke topic > ")) || DEFAULT_TOPIC;
}

export async function main() {
  const executors = createAiSdkExecutors({ models });
  const topic = process.stdin.isTTY ? await promptTopic() : DEFAULT_TOPIC;

  const result = await runAgent(jokeMachine, {
    input: { topic },
    ...executors,
    onChunk: (chunk) => process.stdout.write(chunk),
    onTransition: (snapshot) => {
      const value = snapshot.value;
      if (value === "telling") console.log(`\n${pick(funnyPhrases)}`);
      if (value === "rating") console.log(`\n${pick(ratingPhrases)}`);
    },
  });

  if (result.status !== "done") {
    throw new Error(`Joke agent did not complete: ${result.status}`);
  }
  console.log(
    `\n\nTold ${result.output.jokes.length} joke(s) about "${result.output.topic}". ` +
      `Final rating: ${result.output.lastRating}`,
  );
}

if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  if (!process.env.OPENAI_API_KEY) {
    console.error("Set OPENAI_API_KEY to run this example.");
    process.exit(1);
  }
  void main();
}
