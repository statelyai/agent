/**
 * Multi-agent debate — two speakers argue a motion over a fixed number of
 * rounds, then a judge scores them.
 *
 * A widely copied community LangGraph tutorial pattern: a "pro" agent and a
 * "con" agent take turns adding to a shared transcript, a conditional edge
 * counts rounds, and a judge node picks the winner.
 *
 * LangGraph shape (third-party tutorials; see docs concepts/multi_agent):
 *
 *   START → pro → con ─┬─ pro        (rounds < N)
 *                      └─ judge → END
 *
 * Here the turn order and the round count live in the machine, not in a prompt
 * that tells the model "you have two rounds":
 *
 *   proSpeaking → conSpeaking → checkingRound ─┬─ proSpeaking (round < rounds)
 *                                              └─ judging → done
 *
 * What maps to what:
 *   - pro node            → `proSpeaking` (request `argueFor`)
 *   - con node            → `conSpeaking` (request `argueAgainst`)
 *   - rounds edge         → `checkingRound` (a `choice` state over `round`)
 *   - judge node          → `judging` (structured verdict: winner, reasoning, scores)
 *   - messages reducer    → `transcript` in context, appended on each speaker's `onDone`
 *
 * Differences from LangGraph worth calling out:
 *   - The round budget is data with a ceiling: input `rounds` is clamped by its
 *     schema to `MAX_ROUNDS`, and the loop guard compares against both. A
 *     LangGraph version counts messages in a router function and relies on
 *     recursion_limit if the count is wrong.
 *   - A speaker cannot speak out of turn or end the debate early: neither
 *     request can choose a next state. Only the machine's edges can.
 *   - Any speaker or judge failure lands in `failed` with the transcript so far.
 *
 * No stand-ins: every node is a model call.
 * Run: OPENAI_API_KEY=... npx tsx examples/multi-agent-debate/index.ts
 */
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { createAiSdkExecutors } from "@statelyai/agent/ai-sdk";
import { getStatePath, runAgent, setupAgent, type AgentRequestExecutors } from "@statelyai/agent";

const models = {
  debater: openai("gpt-5.4-mini"),
  judge: openai("gpt-5.4-mini"),
};

/** Upper bound on debate rounds (one pro turn + one con turn each). */
export const MAX_ROUNDS = 3;

const turnSchema = z.object({
  side: z.enum(["pro", "con"]),
  round: z.number(),
  argument: z.string(),
});
type Turn = z.infer<typeof turnSchema>;

const score = z.number().min(0).max(10);
const verdictSchema = z.object({
  winner: z.enum(["pro", "con", "draw"]),
  reasoning: z.string(),
  scores: z.object({ pro: score, con: score }),
});

const contextSchema = z.object({
  motion: z.string(),
  rounds: z.number(),
  // The round in progress, 1-based.
  round: z.number(),
  transcript: z.array(turnSchema),
  verdict: verdictSchema.nullable(),
  failure: z.string().nullable(),
});

/** `Round 1 — PRO: ...` lines. */
function renderTranscript(transcript: Turn[]): string {
  return transcript
    .map((turn) => `Round ${turn.round} — ${turn.side.toUpperCase()}: ${turn.argument}`)
    .join("\n\n");
}

type DebateContext = z.infer<typeof contextSchema>;

/** What each speaker sees: the motion, where the debate is, and what was said. */
function turnInput(context: DebateContext) {
  return {
    motion: context.motion,
    round: context.round,
    rounds: context.rounds,
    transcript: renderTranscript(context.transcript),
  };
}

/** The transcript with one more turn appended (the messages reducer, inline). */
function addTurn(context: DebateContext, side: Turn["side"], argument: string): Turn[] {
  return [...context.transcript, { side, round: context.round, argument }];
}

const speakerInput = z.object({
  motion: z.string(),
  round: z.number(),
  rounds: z.number(),
  transcript: z.string(),
});

const speakerPrompt = ({ input }: { input: z.infer<typeof speakerInput> }) =>
  [
    `Motion: ${input.motion}`,
    `Round ${input.round} of ${input.rounds}.`,
    "Transcript so far:",
    input.transcript || "(you speak first)",
  ].join("\n");

const outputSchema = z.object({
  verdict: z.string(),
  transcript: z.string(),
  winner: z.enum(["pro", "con", "draw"]).nullable(),
  scores: z.object({ pro: z.number(), con: z.number() }).nullable(),
  rounds: z.number(),
});

const agentSetup = setupAgent({
  models,
  context: contextSchema,
  input: z.object({
    motion: z.string(),
    rounds: z.number().int().min(1).max(MAX_ROUNDS).default(2),
  }),
  output: outputSchema,
  requests: {
    argueFor: {
      schemas: { input: speakerInput, output: z.object({ argument: z.string() }) },
      model: "debater",
      system:
        "You argue FOR the motion in a formal debate. Make one new point and answer the " +
        "opponent's last point. At most four sentences.",
      prompt: speakerPrompt,
    },
    argueAgainst: {
      schemas: { input: speakerInput, output: z.object({ argument: z.string() }) },
      model: "debater",
      system:
        "You argue AGAINST the motion in a formal debate. Make one new point and rebut the " +
        "proposer's last point. At most four sentences.",
      prompt: speakerPrompt,
    },
    judgeDebate: {
      schemas: {
        input: z.object({ motion: z.string(), transcript: z.string() }),
        output: verdictSchema,
      },
      model: "judge",
      system:
        "You judge a debate on argument quality alone, not on your own view of the motion. " +
        "Score each side 0-10, name the winner (or a draw), and give your reasoning in two sentences.",
      prompt: ({ input }) => `Motion: ${input.motion}\n\nTranscript:\n${input.transcript}`,
    },
  },
});

export const multiAgentDebateSchemas = agentSetup.schemas;

export const multiAgentDebateMachine = agentSetup.createMachine({
  id: "multi-agent-debate",
  context: ({ input }) => ({
    motion: input.motion,
    rounds: input.rounds,
    round: 1,
    transcript: [],
    verdict: null,
    failure: null,
  }),
  initial: "proSpeaking",
  states: {
    proSpeaking: {
      invoke: {
        src: "argueFor",
        input: ({ context }) => turnInput(context),
        onDone: ({ context, output }) => ({
          target: "conSpeaking",
          context: { transcript: addTurn(context, "pro", output.result.argument) },
        }),
        onError: ({ event }) => ({
          target: "failed",
          context: { failure: `argueFor failed: ${String(event.error)}` },
        }),
      },
    },
    conSpeaking: {
      invoke: {
        src: "argueAgainst",
        input: ({ context }) => turnInput(context),
        onDone: ({ context, output }) => ({
          target: "checkingRound",
          context: { transcript: addTurn(context, "con", output.result.argument) },
        }),
        onError: ({ event }) => ({
          target: "failed",
          context: { failure: `argueAgainst failed: ${String(event.error)}` },
        }),
      },
    },
    // The rounds edge. `rounds` is already clamped by the input schema; the
    // MAX_ROUNDS term keeps the bound visible in the guard itself.
    checkingRound: {
      type: "choice",
      choice: ({ context }) =>
        context.round < Math.min(context.rounds, MAX_ROUNDS)
          ? { target: "proSpeaking", context: { round: context.round + 1 } }
          : { target: "judging" },
    },
    judging: {
      invoke: {
        src: "judgeDebate",
        input: ({ context }) => ({
          motion: context.motion,
          transcript: renderTranscript(context.transcript),
        }),
        onDone: ({ output }) => ({ target: "done", context: { verdict: output.result } }),
        onError: ({ event }) => ({
          target: "failed",
          context: { failure: `judgeDebate failed: ${String(event.error)}` },
        }),
      },
    },
    done: {
      type: "final",
      output: ({ context }) => ({
        verdict: `Winner: ${context.verdict?.winner ?? "draw"} — ${context.verdict?.reasoning ?? ""}`,
        transcript: renderTranscript(context.transcript),
        winner: context.verdict?.winner ?? null,
        scores: context.verdict?.scores ?? null,
        rounds: context.round,
      }),
    },
    // Best-effort terminal: the transcript so far, and why it stopped.
    failed: {
      type: "final",
      output: ({ context }) => ({
        verdict: `No verdict. ${context.failure ?? "The debate failed."}`,
        transcript: renderTranscript(context.transcript),
        winner: null,
        scores: null,
        rounds: context.round,
      }),
    },
  },
});

const DEFAULT_MOTION = "Agent control flow belongs in code, not in prompts.";

export interface RunMultiAgentDebateOptions {
  motion?: string;
  rounds?: number;
  /** Injected for tests; direct run supplies a real model executor. */
  generateText?: AgentRequestExecutors["generateText"];
  /** Observes each machine transition. */
  onProgress?: (state: string) => void;
}

export type MultiAgentDebateResult = z.infer<typeof outputSchema> & {
  finalState: string;
  progress: string[];
};

/** Runs the debate; records state progress so every turn is observable. */
export async function runMultiAgentDebateExample(
  options: RunMultiAgentDebateOptions = {},
): Promise<MultiAgentDebateResult> {
  const { motion = DEFAULT_MOTION, rounds, generateText, onProgress } = options;
  const progress: string[] = [];
  const result = await runAgent(multiAgentDebateMachine, {
    input: { motion, ...(rounds !== undefined ? { rounds } : {}) },
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
    throw new Error(`Multi-agent debate example did not complete: ${result.status}`);
  }
  return { ...result.output, finalState: progress.at(-1) ?? "", progress };
}

// Run directly (`tsx index.ts`); skipped when a test imports this module.
if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  if (!process.env.OPENAI_API_KEY) throw new Error("Set OPENAI_API_KEY to run this example.");
  void runMultiAgentDebateExample({ onProgress: (state) => console.log(`  → ${state}`) }).then(
    (result) => console.log(`\n${result.transcript}\n\n${result.verdict}`),
  );
}
