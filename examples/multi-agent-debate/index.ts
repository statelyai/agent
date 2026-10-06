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
 *   - judge node          → `judging` (Jev judgment `judgeDebate`: a `score` per
 *                           side; the winner is derived from the scores — see note below)
 *   - messages reducer    → `transcript` in context, appended on each speaker's `onDone`
 *
 * Differences from LangGraph worth calling out:
 *   - The round budget is data with a ceiling: input `rounds` is clamped by its
 *     schema to `MAX_ROUNDS`, and the loop guard compares against both. A
 *     LangGraph version counts messages in a router function and relies on
 *     recursion_limit if the count is wrong.
 *   - A speaker cannot speak out of turn or end the debate early: neither
 *     request can choose a next state. Only the machine's edges can.
 *   - Each speaker's stance is pinned in its prompt on EVERY turn, not only in
 *     its system prompt, so a later round reading a long transcript of the
 *     other side's points does not drift into arguing the opposite side.
 *   - Any speaker or judge failure lands in `failed` with the transcript so far.
 *   - Judging is a JUDGMENT, not a generation. `judging` asks the AI SDK's
 *     `experimental_evaluate` with Jev (`@ai-sdk/typesafe-ai`) as the
 *     evaluation model two questions in one call over `{ motion, transcript }`:
 *     `proCase` / `conCase` (a `score` per side on six concrete levels,
 *     `CASE_LEVELS`, mapped to 0-10 in code). The winner is DERIVED from those
 *     two scores (higher wins, equal is a draw), never asked separately, so a
 *     verdict can never name a winner its own scores contradict. The reasoning
 *     is rendered from each side's matched level, not written by a model. The
 *     speakers stay text-model requests: arguing is generative.
 *
 * No stand-ins: every speaker is a model call and the judge a Jev call.
 * Run: OPENAI_API_KEY=... TYPESAFE_AI_API_KEY=... npx tsx examples/multi-agent-debate/index.ts
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
  debater: openai("gpt-5.4-mini"),
};

/**
 * The judge: TypeSafe's Jev through the AI SDK's evaluation-model provider.
 * Reads `TYPESAFE_AI_API_KEY`. Tests pass a mock evaluation model instead.
 */
const judgeModel: Experimental_EvaluationModel = typeSafeAi.evaluationModel("jev-latest");

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

/** How strong one side's case was, lowest to highest (mapped to 0-10). */
export const CASE_LEVELS = [
  "Made no real argument: off-topic, slogans, or contradicted its own side.",
  "Asserted positions without reasons or evidence, and ignored the opponent.",
  "Gave reasons for its side but left the opponent's main points unanswered.",
  "Gave reasons and rebutted some of the opponent's points, with gaps or thin evidence.",
  "Made well-supported points and directly rebutted the opponent's strongest points.",
  "Built a clear, well-evidenced case that answered every major opposing point.",
] as const;

/** One side's case, judged on argument quality over that side's turns. */
function caseQuestion(side: Turn["side"]) {
  const stance = side === "pro" ? "for" : "against";
  return {
    type: "score" as const,
    instructions:
      `How strong is the case made by the \`transcript\` turns whose \`side\` is "${side}" ` +
      `(arguing ${stance} \`motion\`)? Judge argument quality only, not your view of the motion.`,
    criteria: CASE_LEVELS,
  };
}

/**
 * The judge node as a judgment: the motion and the transcript are the state;
 * one `score` per side rates its case. The winner is derived from these two
 * scores (see `decide`), so there is no separate winner question to disagree
 * with them. The judge model is injected by tests and hosts; the default is Jev.
 */
export function createJudgeDebate(model: Experimental_EvaluationModel = judgeModel) {
  return createAsyncLogic<
    { answers: { proCase: { score: number }; conCase: { score: number } } },
    { motion: string; transcript: Turn[] }
  >({
    run: async ({ input, signal }) => {
      const { answers } = await evaluate({
        model,
        state: { motion: input.motion, transcript: input.transcript },
        questions: {
          proCase: caseQuestion("pro"),
          conCase: caseQuestion("con"),
        },
        abortSignal: signal,
      });
      return { answers };
    },
  });
}

/**
 * A side's level on 0-10, to one decimal. Jev's score is an expected level
 * (fractional), so rounding to whole levels would call a 3.6 and a 3.4 a tie
 * while describing them as different levels.
 */
function toTen(level: number) {
  return Math.round((level / (CASE_LEVELS.length - 1)) * 100) / 10;
}

/**
 * The verdict from the two case scores: the higher 0-10 score wins, equal
 * scores are a draw. Compared on the same rounded scores the output shows, so
 * the winner always agrees with them.
 */
function decide(proLevel: number, conLevel: number) {
  const scores = { pro: toTen(proLevel), con: toTen(conLevel) };
  const winner: "pro" | "con" | "draw" =
    scores.pro > scores.con ? "pro" : scores.con > scores.pro ? "con" : "draw";
  const describe = (level: number) => CASE_LEVELS[Math.round(level)] ?? "";
  // "Pro 8/10: <level> Con 6/10: <level>" — rendered, not generated.
  const reasoning =
    `Pro ${scores.pro}/10: ${describe(proLevel)} ` + `Con ${scores.con}/10: ${describe(conLevel)}`;
  return { winner, reasoning, scores };
}

/** What each speaker sees: the motion, where the debate is, and what was said. */
function turnInput(context: DebateContext) {
  return {
    motion: context.motion,
    round: context.round,
    rounds: context.rounds,
    transcript: renderTranscript(context.transcript),
  };
}

/**
 * How a turn reads. The earlier wording ("make one new point and rebut…")
 * came back as labeled parts ("New point: …", "Rebuttal: …"), so the form is
 * spelled out as one unlabeled paragraph.
 */
const TURN_FORM =
  "Write one paragraph of plain, continuous prose, at most four sentences: answer the " +
  "opponent's last point (if any), then add one argument not yet made. Do not label the " +
  "parts — no 'New point:', 'Rebuttal:', headings, or lists.";

/** Part labels a speaker may still prefix a sentence with; dropped from the turn. */
const PART_LABEL =
  /(^|[.!?]\s+)(?:new point|rebuttal|counterpoint|point|argument)\s*:\s*([a-z])?/gi;

/** The turn as prose: any leftover part labels removed. */
export function plainArgument(argument: string): string {
  return argument
    .trim()
    .replace(
      PART_LABEL,
      (_match, lead: string, letter?: string) => lead + (letter?.toUpperCase() ?? ""),
    );
}

/** The transcript with one more turn appended (the messages reducer, inline). */
function addTurn(context: DebateContext, side: Turn["side"], argument: string): Turn[] {
  return [...context.transcript, { side, round: context.round, argument: plainArgument(argument) }];
}

const speakerInput = z.object({
  motion: z.string(),
  round: z.number(),
  rounds: z.number(),
  transcript: z.string(),
});

/**
 * One speaker's turn prompt. The stance is restated on every turn, last, so it
 * is the freshest instruction after a transcript full of the other side's
 * points.
 */
const speakerPrompt =
  (stance: "FOR" | "AGAINST") =>
  ({ input }: { input: z.infer<typeof speakerInput> }) =>
    [
      `Motion: ${input.motion}`,
      `Round ${input.round} of ${input.rounds}.`,
      "Transcript so far:",
      input.transcript || "(you speak first)",
      "",
      `Your side: ${stance} the motion. Argue only ${stance.toLowerCase()} it this round; ` +
        "never concede the motion or switch sides.",
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
  // The judge node: a Jev judgment (see createJudgeDebate).
  actors: { judgeDebate: createJudgeDebate() },
  requests: {
    argueFor: {
      schemas: { input: speakerInput, output: z.object({ argument: z.string() }) },
      model: "debater",
      system: "You argue FOR the motion in a formal debate. " + TURN_FORM,
      prompt: speakerPrompt("FOR"),
    },
    argueAgainst: {
      schemas: { input: speakerInput, output: z.object({ argument: z.string() }) },
      model: "debater",
      system: "You argue AGAINST the motion in a formal debate. " + TURN_FORM,
      prompt: speakerPrompt("AGAINST"),
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
          transcript: context.transcript,
        }),
        onDone: ({ output }) => ({
          target: "done",
          context: { verdict: decide(output.answers.proCase.score, output.answers.conCase.score) },
        }),
        onError: ({ event }) => ({
          target: "failed",
          context: { failure: `judgeDebate failed: ${String(event.error)}` },
        }),
      },
    },
    done: {
      type: "final",
      output: ({ context }) => ({
        verdict: `${
          !context.verdict || context.verdict.winner === "draw"
            ? "Draw"
            : `Winner: ${context.verdict.winner}`
        } — ${context.verdict?.reasoning ?? ""}`,
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
  /** The judge model; tests pass a mock, the direct run uses Jev. */
  judge?: Experimental_EvaluationModel;
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
  const { motion = DEFAULT_MOTION, rounds, generateText, judge, onProgress } = options;
  const progress: string[] = [];
  const result = await runToQuiescence(
    createAgentRuntime(multiAgentDebateMachine, {
      ...(generateText
        ? { executors: { generateText } }
        : { executors: createAiSdkExecutors({ models }) }),
      ...(judge ? { actors: { judgeDebate: createJudgeDebate(judge) } } : {}),
      onTransition: (snapshot) => {
        const state = getStatePath(snapshot);
        progress.push(state);
        onProgress?.(state);
      },
    }),
    {
      input: { motion, ...(rounds !== undefined ? { rounds } : {}) },
    },
  );
  if (result.status !== "done") {
    throw new Error(`Multi-agent debate example did not complete: ${result.status}`);
  }
  return { ...result.output, finalState: progress.at(-1) ?? "", progress };
}

// Run directly (`tsx index.ts`); skipped when a test imports this module.
if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  if (!process.env.OPENAI_API_KEY || !process.env.TYPESAFE_AI_API_KEY) {
    throw new Error("Set OPENAI_API_KEY and TYPESAFE_AI_API_KEY to run this example.");
  }
  void runMultiAgentDebateExample({ onProgress: (state) => console.log(`  → ${state}`) }).then(
    (result) => console.log(`\n${result.transcript}\n\n${result.verdict}`),
  );
}
