/**
 * Prompt chaining — generate a joke, gate it on a programmatic check, then
 * improve and polish it in two more model calls.
 *
 * Ported from the prompt-chaining section of LangGraph's "Workflows and
 * Agents" tutorial (Anthropic's "Building effective agents" pattern). Each
 * model call works on the previous one's output, and a plain-code gate between
 * steps decides whether the chain continues.
 *
 * LangGraph shape:
 *
 *   START → generate_joke → check_punchline ─┬─ "Pass" → improve_joke → polish_joke → END
 *                                            └─ "Fail" → END
 *
 * Machine shape:
 *
 *   generating → checkingPunchline ─┬─ improving → polishing → done
 *                     ▲             ├─ regenerating ─┐
 *                     └─────────────┼────────────────┘
 *                                   └─ failed (regenerations spent)
 *
 * What maps to what:
 *   - generate_joke    → `generating`, the `generateJoke` request
 *   - check_punchline  → `checkingPunchline`, a choice state whose guard is the
 *                        tutorial's pure check (the joke contains "?" or "!")
 *   - improve_joke     → `improving`, the `improveJoke` request
 *   - polish_joke      → `polishing`, the `polishJoke` request
 *   - "Fail" → END     → `regenerating`, then `failed` once the budget is spent
 *
 * Differences from LangGraph worth calling out:
 *   - LangGraph ends the run on a failed check. Here a failed check retries
 *     generation up to `MAX_REGENERATIONS` times, and only then lands in
 *     `failed`, returning the last joke and saying why.
 *   - `stage` in the output says how far the chain got (generated, improved,
 *     polished), so a failure mid-chain still returns the best joke so far.
 *
 * Dual-mode: `runPromptChainingExample(options?)` takes an injectable
 * `generateText` (tests script it); the direct run uses real models.
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/prompt-chaining/index.ts
 */
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { createAiSdkExecutors } from "@statelyai/agent/ai-sdk";
import {
  getStatePath,
  createAgentRuntime,
  runToQuiescence,
  setupAgent,
  type AgentRequestExecutors,
} from "@statelyai/agent";

const models = { writer: openai("gpt-5.4-mini") };

/** Extra generation attempts after a failed punchline check, before `failed`. */
export const MAX_REGENERATIONS = 2;

/** The tutorial's gate, verbatim: a punchline shows up as "?" or "!". */
export function hasPunchline(joke: string): boolean {
  return joke.includes("?") || joke.includes("!");
}

const stageSchema = z.enum(["generated", "improved", "polished"]);
const jokeSchema = z.object({ joke: z.string() });

const contextSchema = z.object({
  topic: z.string(),
  joke: z.string().nullable(),
  stage: stageSchema,
  regenerations: z.number().int(),
  /** The one human-readable progress line. */
  notice: z.string(),
});

function finalOutput(context: z.infer<typeof contextSchema>) {
  return {
    joke: context.joke ?? "(no joke generated)",
    stage: context.stage,
    regenerations: context.regenerations,
    trail: [
      `Stage reached: ${context.stage}.`,
      `Regenerations: ${context.regenerations} of ${MAX_REGENERATIONS}.`,
      context.notice,
    ],
  };
}

const agentSetup = setupAgent({
  models,
  context: contextSchema,
  input: z.object({ topic: z.string() }),
  output: z.object({
    joke: z.string(),
    stage: stageSchema,
    regenerations: z.number().int(),
    trail: z.array(z.string()),
  }),
  requests: {
    generateJoke: {
      schemas: {
        input: z.object({ topic: z.string(), previousJoke: z.string().nullable() }),
        output: jokeSchema,
      },
      model: "writer",
      // The gate is a pure check for "?" or "!", so the prompt states it: the
      // tutorial leaves the model to guess why its joke was rejected.
      system:
        "Write a short joke about the topic. End it with a punchline phrased as a " +
        "question or an exclamation, so the joke contains a '?' or a '!'.",
      prompt: ({ input }) =>
        input.previousJoke
          ? `Topic: ${input.topic}\n\nThe last attempt was rejected because it contained no '?' or '!'. Write a new one whose punchline does:\n${input.previousJoke}`
          : `Topic: ${input.topic}`,
    },
    improveJoke: {
      schemas: { input: jokeSchema, output: jokeSchema },
      model: "writer",
      system: "Make this joke funnier by adding wordplay.",
      prompt: ({ input }) => input.joke,
    },
    polishJoke: {
      schemas: { input: jokeSchema, output: jokeSchema },
      model: "writer",
      system: "Add a surprising twist to this joke.",
      prompt: ({ input }) => input.joke,
    },
  },
});

export const promptChainingSchemas = agentSetup.schemas;

export const promptChainingMachine = agentSetup.createMachine({
  id: "prompt-chaining",
  context: ({ input }) => ({
    topic: input.topic,
    joke: null,
    stage: "generated" as const,
    regenerations: 0,
    notice: "Writing the first joke.",
  }),
  initial: "generating",
  states: {
    generating: {
      invoke: {
        src: "generateJoke",
        input: ({ context }) => ({ topic: context.topic, previousJoke: null }),
        onDone: ({ output }) => ({
          target: "checkingPunchline",
          context: { joke: output.result.joke },
        }),
        onError: ({ event }) => ({
          target: "failed",
          context: { notice: `generateJoke failed: ${String(event.error)}` },
        }),
      },
    },
    // check_punchline: the gate is plain code, and its three exits are states.
    checkingPunchline: {
      type: "choice",
      choice: ({ context }) => {
        if (hasPunchline(context.joke ?? "")) {
          return { target: "improving", context: { notice: "Punchline check passed." } };
        }
        if (context.regenerations < MAX_REGENERATIONS) {
          return { target: "regenerating", context: { notice: "No punchline; regenerating." } };
        }
        const notice = `No punchline after ${MAX_REGENERATIONS} regenerations; kept the last joke.`;
        return { target: "failed", context: { notice } };
      },
    },
    regenerating: {
      invoke: {
        src: "generateJoke",
        input: ({ context }) => ({ topic: context.topic, previousJoke: context.joke }),
        onDone: ({ context, output }) => ({
          target: "checkingPunchline",
          context: { joke: output.result.joke, regenerations: context.regenerations + 1 },
        }),
        onError: ({ event }) => ({
          target: "failed",
          context: { notice: `generateJoke failed: ${String(event.error)}` },
        }),
      },
    },
    improving: {
      invoke: {
        src: "improveJoke",
        input: ({ context }) => ({ joke: context.joke ?? "" }),
        onDone: ({ output }) => ({
          target: "polishing",
          context: { joke: output.result.joke, stage: "improved" as const },
        }),
        onError: ({ event }) => ({
          target: "failed",
          context: { notice: `improveJoke failed: ${String(event.error)}` },
        }),
      },
    },
    polishing: {
      invoke: {
        src: "polishJoke",
        input: ({ context }) => ({ joke: context.joke ?? "" }),
        onDone: ({ output }) => ({
          target: "done",
          context: {
            joke: output.result.joke,
            stage: "polished" as const,
            notice: "Generated, improved, and polished.",
          },
        }),
        onError: ({ event }) => ({
          target: "failed",
          context: { notice: `polishJoke failed: ${String(event.error)}` },
        }),
      },
    },
    done: { type: "final", output: ({ context }) => finalOutput(context) },
    // Best effort: the last joke and the stage it reached, plus why it stopped.
    failed: { type: "final", output: ({ context }) => finalOutput(context) },
  },
});

export interface RunPromptChainingOptions {
  topic?: string;
  /** Injected for tests; the direct run uses real models. */
  generateText?: AgentRequestExecutors["generateText"];
  onProgress?: (state: string) => void;
}

/** Runs the chain; `outcome` says which final state it reached. */
export async function runPromptChainingExample(options: RunPromptChainingOptions = {}) {
  const { topic = "cats", generateText, onProgress } = options;
  const progress: string[] = [];
  const result = await runToQuiescence(
    createAgentRuntime(promptChainingMachine, {
      ...(generateText
        ? { executors: { generateText } }
        : { executors: createAiSdkExecutors({ models }) }),
      onTransition: (snapshot) => {
        const state = getStatePath(snapshot);
        progress.push(state);
        onProgress?.(state);
      },
    }),
    {
      input: { topic },
    },
  );

  if (result.status !== "done") {
    throw new Error(`Prompt-chaining example did not complete: ${result.status}`);
  }
  return { outcome: getStatePath(result.snapshot), ...result.output, progress };
}

// Run directly (`tsx index.ts`); skipped when a test imports this module.
if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  if (!process.env.OPENAI_API_KEY) throw new Error("Set OPENAI_API_KEY to run this example.");
  void runPromptChainingExample({ onProgress: (state) => console.log(`  → ${state}`) }).then(
    ({ outcome, joke, trail }) => console.log(`\n[${outcome}] ${joke}\n\n${trail.join("\n")}`),
  );
}
