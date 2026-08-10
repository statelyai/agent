/**
 * Joke teller — a machine-owned tell → rate → decide loop, ported from the v1
 * `joke-teller` example.
 *
 * Flow: get a topic from the user → stream a joke about it → rate it 1-10 with
 * an explanation → ALWAYS take one improvement pass (the machine, not the
 * model, guarantees the first revision) → then let the model DECIDE (not a
 * regex) whether to keep going or stop. The decision is an `agent.decide`
 * invoke; the state's own `on:` transitions define the legal choices, so the
 * state machine owns the loop.
 *
 * Dual-mode: `runAgent` takes host executors, so the same machine runs live
 * against real models (readline topic, streaming to stdout) or against mocked
 * executors in tests. See index.test.ts.
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/joke/index.ts
 */
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { createAiSdkExecutors, defineModels } from "@statelyai/agent/ai-sdk";
import { createAgentSchemas, createTextLogic, runAgent, setupAgent } from "@statelyai/agent";

const DEFAULT_TOPIC = "state machines";

/** Hard cap on jokes told, so a run stays short no matter what the model decides. */
const MAX_JOKES = 3;

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
    // The before/after pair the run shows off: the first attempt, kept as-is,
    // and a note saying what it scored and why a revision followed.
    firstJoke: z.string().nullable(),
    revisionNotice: z.string().nullable(),
  }),
  input: z.object({ topic: z.string().default(DEFAULT_TOPIC) }),
  output: z.object({
    joke: z.string(),
    firstJoke: z.string().nullable(),
    revisionNotice: z.string().nullable(),
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

export const models = defineModels({
  jokeWriter: openai("gpt-5.4-mini"),
  critic: openai("gpt-5.4-mini"),
});

export const tellJoke = createTextLogic({
  mode: "stream",
  schemas: {
    input: z.object({
      topic: z.string(),
      // Set on the improvement pass: the joke to beat and the critic's reasons.
      previousJoke: z.string().nullable(),
      rating: z.number().nullable(),
      critique: z.string().nullable(),
    }),
    output: z.string(),
  },
  model: "jokeWriter",
  system: "You tell short, punchy jokes. Stay on topic.",
  prompt: ({ input }) =>
    input.previousJoke
      ? [
          `Previous joke about ${input.topic}:`,
          input.previousJoke,
          `A critic scored it ${input.rating ?? "?"}/10: ${input.critique ?? ""}`,
          "Rewrite it so it lands harder. Return only the new joke.",
        ].join("\n")
      : `Tell a joke about ${input.topic}.`,
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
  actors: jokeActors,
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
    firstJoke: null,
    revisionNotice: null,
  }),
  initial: "telling",
  states: {
    telling: {
      invoke: {
        src: "tellJoke",
        // After the first pass the writer sees the joke to beat and the
        // critique, so `telling` doubles as the revision step.
        input: ({ context }) => ({
          topic: context.topic,
          previousJoke: context.jokes.at(-1) ?? null,
          rating: context.lastRating,
          critique: context.lastExplanation,
        }),
        onDone: ({ context, output }) => ({
          target: "rating",
          context: { jokes: [...context.jokes, output] },
        }),
      },
    },
    rating: {
      invoke: {
        src: "rateJoke",
        input: ({ context }) => ({ joke: context.jokes.at(-1) ?? "" }),
        onDone: ({ context, output }) => {
          const rated = {
            lastRating: output.rating,
            lastExplanation: output.explanation,
          };
          // The first joke ALWAYS gets one improvement pass. The machine owns
          // that rule, so the revision branch shows up on every run instead of
          // depending on whatever the critic happened to score.
          if (context.jokes.length === 1) {
            return {
              target: "telling",
              context: {
                ...rated,
                firstJoke: context.jokes[0]!,
                revisionNotice:
                  `First attempt scored ${output.rating}/10 (${output.explanation}). ` +
                  "Every run takes one improvement pass before deciding whether to stop.",
              },
            };
          }
          // Past that, the model decides — unless the run hits its joke cap.
          return context.jokes.length >= MAX_JOKES
            ? { target: "done", context: rated }
            : { target: "deciding", context: rated };
        },
      },
    },
    deciding: {
      invoke: {
        src: "agent.decide",
        input: ({ context }) => ({
          model: "critic",
          system: DECIDE_SYSTEM,
          prompt: [
            `Last joke rating: ${context.lastRating}`,
            `Explanation: ${context.lastExplanation ?? ""}`,
            "Choose TELL_ANOTHER or END.",
          ].join("\n"),
          // allowedEvents omitted: the state's `on:` below fully defines the
          // legal set (TELL_ANOTHER | END), and the chosen event is delivered
          // automatically — its transition exits `deciding`, ending the invoke.
          maxRetries: 2,
        }),
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
        joke: context.jokes.at(-1) ?? "",
        firstJoke: context.firstJoke,
        revisionNotice: context.revisionNotice,
        topic: context.topic,
        jokes: context.jokes,
        lastRating: context.lastRating,
      }),
    },
  },
});

/** Prompt once on stdin and resolve the trimmed reply. */
async function promptLine(query: string): Promise<string> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(query)).trim();
  } finally {
    rl.close();
  }
}

async function promptTopic(): Promise<string> {
  return (await promptLine("Give me a joke topic > ")) || DEFAULT_TOPIC;
}

export async function main() {
  const topic = process.stdin.isTTY ? await promptTopic() : DEFAULT_TOPIC;

  const result = await runAgent(jokeMachine, {
    input: { topic },
    executors: createAiSdkExecutors({ models }),
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
  if (result.output.revisionNotice) console.log(`\n\n${result.output.revisionNotice}`);
  console.log(
    `\nTold ${result.output.jokes.length} joke(s) about "${result.output.topic}". ` +
      `Final rating: ${result.output.lastRating}`,
  );
}

// Run directly (`tsx index.ts`); skipped when a test imports this module.
if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  if (!process.env.OPENAI_API_KEY) {
    console.error("Set OPENAI_API_KEY to run this example.");
    process.exit(1);
  }
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
