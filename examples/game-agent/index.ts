/**
 * Reducing the event log into context — rock-paper-scissors, first to 3.
 *
 * YOU play the model. Each round the machine appends both throws and the result
 * to `context.history`, and the model's decide prompt renders that log back.
 * The saved history is the ONLY way the model can spot your habits and counter
 * them: each round in isolation is a coin flip. Context IS the agent's memory.
 *
 * Your throws are gated machine events (`HUMAN_ROCK` / `HUMAN_PAPER` /
 * `HUMAN_SCISSORS`) hinted through `meta.interaction`, so hosts and demos
 * render them as buttons: the run settles idle on `awaitingHumanThrow` and
 * resumes with `runAgent(rpsMachine, { snapshot: result.persist(), event })`.
 *
 * For the other half of the "games as machines" story — a combat machine whose
 * `allowedEvents` are computed from context, driven by an AI SDK host — see
 * examples/ai-sdk-host.
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/game-agent/index.ts
 */
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { createAiSdkExecutors, defineModels } from "@statelyai/agent/ai-sdk";
import {
  createAgentSchemas,
  getInteraction,
  interactionMetaSchema,
  runAgent,
  setupAgent,
  type AgentDecisionExecutor,
} from "@statelyai/agent";
import type { SnapshotFrom } from "xstate";

// You throw; the model throws back. Every round the machine appends what
// happened — both throws and the result — to `context.history`. The decide
// prompt renders that log, so the model's only edge is the event history the
// machine saved: each round in isolation is a coin flip, but the log exposes
// whatever habits you fall into. No extra plumbing needed — context IS the
// agent's memory.

const moveSchema = z.enum(["rock", "paper", "scissors"]);
type Move = z.infer<typeof moveSchema>;

const roundSchema = z.object({
  round: z.number(),
  /** Your throw. */
  player: moveSchema,
  /** The model's throw. */
  opponent: moveSchema,
  /** Result from your point of view. */
  result: z.enum(["win", "loss", "tie"]),
});
type Round = z.infer<typeof roundSchema>;

const rpsContextSchema = z.object({
  targetWins: z.number(),
  round: z.number(),
  playerScore: z.number(),
  opponentScore: z.number(),
  /**
   * Your throw for the round in progress, waiting on the model's reply. Null
   * outside `choosingThrow`, which narrows it to a real move.
   */
  pendingThrow: moveSchema.nullable(),
  // The event log: every round's throws and result, in order. This is what
  // the decide prompt reads to find your pattern.
  history: z.array(roundSchema),
});

export const rpsSchemas = createAgentSchemas({
  meta: interactionMetaSchema,
  context: rpsContextSchema,
  input: z.object({
    targetWins: z.number().default(3),
  }),
  output: z.object({
    outcome: z.enum(["won", "lost", "abandoned"]),
    summary: z.string(),
    playerScore: z.number(),
    opponentScore: z.number(),
    history: z.array(roundSchema),
  }),
  events: {
    /** Your throws — gated machine events a host renders as buttons. */
    HUMAN_ROCK: z.object({}),
    HUMAN_PAPER: z.object({}),
    HUMAN_SCISSORS: z.object({}),
    /** The model's throw, chosen by `agent.decide`. */
    THROW_ROCK: z.object({}),
    THROW_PAPER: z.object({}),
    THROW_SCISSORS: z.object({}),
  },
});

export const rpsModels = defineModels({
  movePicker: openai("gpt-5.4-mini"),
});

const BEATS: Record<Move, Move> = {
  rock: "scissors",
  paper: "rock",
  scissors: "paper",
};

/** Resolves the round once both throws are in. `choosingThrow` narrows
 * `pendingThrow` to a real move, so there is no default to fall back to. */
function resolveRound(
  context: { round: number; history: Round[]; pendingThrow: Move },
  opponent: Move,
) {
  const player = context.pendingThrow;
  const result: Round["result"] =
    player === opponent ? "tie" : BEATS[player] === opponent ? "win" : "loss";
  const round = context.round + 1;
  return {
    target: "checkingScore" as const,
    context: {
      round,
      pendingThrow: null,
      history: [...context.history, { round, player, opponent, result }],
    },
  };
}

/**
 * The line above the buttons, derived from the log rather than stored beside
 * it. `meta.interaction.label` takes a function of the context, so nothing has
 * to keep a rendered string in sync.
 */
export function renderNotice(context: {
  targetWins: number;
  playerScore: number;
  opponentScore: number;
  history: Round[];
}): string {
  const last = context.history.at(-1);
  if (!last) {
    return `First to ${context.targetWins} wins. Throw something.`;
  }
  const line =
    last.result === "tie"
      ? `Round ${last.round}: you both threw ${last.player}. Tie.`
      : `Round ${last.round}: you threw ${last.player}, the agent threw ${last.opponent} — you ${last.result === "win" ? "win" : "lose"} it.`;
  return `${line} Score: you ${context.playerScore}, agent ${context.opponentScore}.`;
}

/** Renders the event log for the prompt: one line per round. */
export function renderHistory(history: Round[]): string {
  if (history.length === 0) {
    return "No rounds played yet.";
  }
  return history
    .map(
      (entry) =>
        `Round ${entry.round}: human threw ${entry.player}, you threw ${entry.opponent} — human ${entry.result}`,
    )
    .join("\n");
}

/** Readable end-of-match recap. */
export function renderMatch(
  history: Round[],
  outcome: "won" | "lost",
  playerScore: number,
  opponentScore: number,
): string {
  const lines = history.map(
    (entry) =>
      `Round ${entry.round}: you ${entry.player} vs agent ${entry.opponent} — ${
        entry.result === "tie" ? "tie" : entry.result === "win" ? "you win" : "agent wins"
      }`,
  );
  return [...lines, `You ${outcome} the match ${playerScore}-${opponentScore}.`].join("\n");
}

const rpsSetup = setupAgent({
  schemas: rpsSchemas,
  models: rpsModels,
  states: {
    awaitingHumanThrow: {},
    // Reachable only after one of the HUMAN_* events set `pendingThrow`, so
    // the round can be resolved without a `?? "rock"` that never fires.
    choosingThrow: {
      schemas: { context: rpsContextSchema.extend({ pendingThrow: moveSchema }) },
    },
    checkingScore: {},
    won: {},
    lost: {},
    abandoned: {},
  },
});

export const rpsMachine = rpsSetup.createMachine({
  id: "rps-event-log",
  context: ({ input }) => ({
    targetWins: input.targetWins,
    round: 0,
    playerScore: 0,
    opponentScore: 0,
    pendingThrow: null,
    history: [],
  }),
  initial: "awaitingHumanThrow",
  states: {
    // No invoke: the run settles idle here and a host resumes with one of the
    // accepted events. `meta.interaction` labels them as buttons, and the label
    // is a function of the context, so the recap is derived at render time.
    awaitingHumanThrow: {
      tags: ["waiting"],
      meta: {
        interaction: {
          label: ({ context }) => renderNotice(context),
          events: {
            HUMAN_ROCK: { label: "Rock", style: "primary" },
            HUMAN_PAPER: { label: "Paper", style: "primary" },
            HUMAN_SCISSORS: { label: "Scissors", style: "primary" },
          },
        },
      },
      on: {
        HUMAN_ROCK: { target: "choosingThrow", context: { pendingThrow: "rock" as const } },
        HUMAN_PAPER: { target: "choosingThrow", context: { pendingThrow: "paper" as const } },
        HUMAN_SCISSORS: {
          target: "choosingThrow",
          context: { pendingThrow: "scissors" as const },
        },
      },
    },
    choosingThrow: {
      invoke: {
        src: "agent.decide",
        // The payoff line: the prompt is built FROM the saved event log. The
        // model sees every prior round and can extrapolate the human's habits.
        input: ({ context }) => ({
          model: "movePicker",
          system: [
            "You are playing rock-paper-scissors against a human.",
            "Study the round history for the human's habits, predict their next",
            "throw, and throw what beats it.",
          ].join(" "),
          prompt: [
            renderHistory(context.history),
            `Score: human ${context.playerScore}, you ${context.opponentScore}.`,
            "Choose your next throw.",
          ].join("\n"),
        }),
        // The opponent could not produce a legal throw. The match ends
        // unfinished rather than hanging on a throw that never comes.
        onError: { target: "abandoned" },
      },
      on: {
        THROW_ROCK: ({ context }) => resolveRound(context, "rock"),
        THROW_PAPER: ({ context }) => resolveRound(context, "paper"),
        THROW_SCISSORS: ({ context }) => resolveRound(context, "scissors"),
      },
    },
    checkingScore: {
      type: "choice",
      choice: ({ context }) => {
        const last = context.history[context.history.length - 1]!;
        const playerScore = context.playerScore + (last.result === "win" ? 1 : 0);
        const opponentScore = context.opponentScore + (last.result === "loss" ? 1 : 0);
        const target =
          playerScore >= context.targetWins
            ? ("won" as const)
            : opponentScore >= context.targetWins
              ? ("lost" as const)
              : ("awaitingHumanThrow" as const);
        return { target, context: { playerScore, opponentScore } };
      },
    },
    won: {
      type: "final",
      output: ({ context }) => ({
        outcome: "won" as const,
        summary: renderMatch(context.history, "won", context.playerScore, context.opponentScore),
        playerScore: context.playerScore,
        opponentScore: context.opponentScore,
        history: context.history,
      }),
    },
    lost: {
      type: "final",
      output: ({ context }) => ({
        outcome: "lost" as const,
        summary: renderMatch(context.history, "lost", context.playerScore, context.opponentScore),
        playerScore: context.playerScore,
        opponentScore: context.opponentScore,
        history: context.history,
      }),
    },
    abandoned: {
      type: "final",
      output: ({ context }) => ({
        outcome: "abandoned" as const,
        summary: [
          ...context.history.map(
            (entry) => `Round ${entry.round}: you ${entry.player} vs agent ${entry.opponent}`,
          ),
          "The opponent could not throw. Match abandoned.",
        ].join("\n"),
        playerScore: context.playerScore,
        opponentScore: context.opponentScore,
        history: context.history,
      }),
    },
  },
});

/** What a host (or the test) sends to unblock the idle RPS machine. */
export type HumanThrowEvent = { type: "HUMAN_ROCK" | "HUMAN_PAPER" | "HUMAN_SCISSORS" };

type RpsSnapshot = SnapshotFrom<typeof rpsMachine>;

/** Turns free text ("rock", "r", "paper") into the event the idle state accepts. */
export function toThrowEvent(text: string): HumanThrowEvent {
  const value = text.trim().toLowerCase();
  if (value.startsWith("p")) return { type: "HUMAN_PAPER" };
  if (value.startsWith("s")) return { type: "HUMAN_SCISSORS" };
  return { type: "HUMAN_ROCK" };
}

/**
 * Plays a full RPS match, settling idle on every one of your throws and
 * resuming from `result.persist()`. The test passes mock executors and
 * scripted throws, so CI needs no API key.
 */
export async function runRpsExample(options?: {
  input?: { targetWins?: number };
  decide?: AgentDecisionExecutor;
  /** Scripted throws, consumed in order on each idle settle. */
  humanThrows?: HumanThrowEvent[];
  /** Or decide per idle snapshot; falls back to `humanThrows`, then stdin. */
  nextHumanThrow?: (snapshot: RpsSnapshot) => HumanThrowEvent | undefined;
  onNotice?: (notice: string) => void;
}) {
  const queued = [...(options?.humanThrows ?? [])];
  const shared = {
    executors: options?.decide
      ? { decide: options.decide }
      : createAiSdkExecutors({ models: rpsModels }),
    maxModelCalls: 30,
  };

  let result = await runAgent(rpsMachine, {
    input: { targetWins: options?.input?.targetWins ?? 3 },
    ...shared,
  });

  // Every throw settles the run idle. Resume from `result.persist()`.
  while (result.status === "idle") {
    const label = getInteraction(result.snapshot)?.label ?? "Your throw?";
    options?.onNotice?.(label);
    const event =
      options?.nextHumanThrow?.(result.snapshot) ??
      queued.shift() ??
      toThrowEvent(await promptLine(`${label}\n(rock/paper/scissors) > `));
    result = await runAgent(rpsMachine, {
      snapshot: result.persist(),
      event,
      ...shared,
    });
  }

  if (result.status !== "done") {
    throw new Error(`Match did not finish: ${result.status}`);
  }
  return result.output;
}

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

export async function main() {
  const rps = await runRpsExample();
  console.log(`\n${rps.summary}`);
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
