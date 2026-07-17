/**
 * Event log in machine context: rock-paper-scissors against an opponent that
 * plays a fixed repeating pattern (rock, rock, paper). Every round the machine
 * appends what happened — both throws and the result — to `context.history`.
 * The decide prompt renders that log, so the model's ONLY path to winning is
 * the event history the machine saved: each round in isolation is a coin
 * flip, but the log exposes the opponent's cycle.
 *
 * This is the manual version of "give the agent the events that happened":
 * the machine reduces its own events into context, and the prompt reads them
 * back. No runAgent plumbing needed — context IS the agent's memory.
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/event-log-game/index.ts
 */
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { createAiSdkExecutors, defineModels } from "../../src/ai-sdk/index.js";
import { createAgentSchemas, runAgent, setupAgent } from "../../src/index.js";
import { runExampleMain } from "../helpers/main.js";

const moveSchema = z.enum(["rock", "paper", "scissors"]);
type Move = z.infer<typeof moveSchema>;

const roundSchema = z.object({
  round: z.number(),
  player: moveSchema,
  opponent: moveSchema,
  result: z.enum(["win", "loss", "tie"]),
});
type Round = z.infer<typeof roundSchema>;

export const rpsSchemas = createAgentSchemas({
  context: z.object({
    targetWins: z.number(),
    round: z.number(),
    playerScore: z.number(),
    opponentScore: z.number(),
    // The event log: every round's throws and result, in order. This is what
    // the decide prompt reads to find the opponent's pattern.
    history: z.array(roundSchema),
  }),
  input: z.object({
    targetWins: z.number().default(3),
  }),
  output: z.object({
    outcome: z.enum(["won", "lost"]),
    playerScore: z.number(),
    opponentScore: z.number(),
    history: z.array(roundSchema),
  }),
  events: {
    THROW_ROCK: z.object({}),
    THROW_PAPER: z.object({}),
    THROW_SCISSORS: z.object({}),
  },
});

export const rpsModels = defineModels({
  movePicker: openai("gpt-5.4-mini"),
});

// The opponent's script: rock, rock, paper, repeating. Deterministic so the
// log is genuinely predictive.
const OPPONENT_PATTERN: Move[] = ["rock", "rock", "paper"];

const BEATS: Record<Move, Move> = {
  rock: "scissors",
  paper: "rock",
  scissors: "paper",
};

function playRound(context: { round: number; history: Round[] }, player: Move) {
  const opponent = OPPONENT_PATTERN[context.round % OPPONENT_PATTERN.length]!;
  const result: Round["result"] =
    player === opponent ? "tie" : BEATS[player] === opponent ? "win" : "loss";
  return {
    target: "checkingScore" as const,
    context: {
      round: context.round + 1,
      history: [...context.history, { round: context.round + 1, player, opponent, result }],
    },
  };
}

/** Renders the event log for the prompt: one line per round. */
export function renderHistory(history: Round[]): string {
  if (history.length === 0) {
    return "No rounds played yet.";
  }
  return history
    .map(
      (entry) =>
        `Round ${entry.round}: you threw ${entry.player}, opponent threw ${entry.opponent} — ${entry.result}`,
    )
    .join("\n");
}

const rpsSetup = setupAgent({
  schemas: rpsSchemas,
  models: rpsModels,
  states: {
    choosingThrow: {},
    checkingScore: {},
    won: {},
    lost: {},
  },
});

export const rpsMachine = rpsSetup.createMachine({
  id: "rps-event-log",
  context: ({ input }) => ({
    targetWins: input.targetWins,
    round: 0,
    playerScore: 0,
    opponentScore: 0,
    history: [],
  }),
  initial: "choosingThrow",
  states: {
    choosingThrow: {
      invoke: {
        src: "agent.decide",
        // The payoff line: the prompt is built FROM the saved event log. The
        // model sees every prior round and can extrapolate the cycle.
        input: ({ context }) => ({
          model: "movePicker",
          system: [
            "You are playing rock-paper-scissors. The opponent follows a",
            "repeating pattern. Study the round history, infer the pattern,",
            "predict the opponent's next throw, and throw what beats it.",
          ].join(" "),
          prompt: [
            renderHistory(context.history),
            `Score: you ${context.playerScore}, opponent ${context.opponentScore}.`,
            "Choose your next throw.",
          ].join("\n"),
        }),
      },
      on: {
        THROW_ROCK: ({ context }) => playRound(context, "rock"),
        THROW_PAPER: ({ context }) => playRound(context, "paper"),
        THROW_SCISSORS: ({ context }) => playRound(context, "scissors"),
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
              : ("choosingThrow" as const);
        return { target, context: { playerScore, opponentScore } };
      },
    },
    won: {
      type: "final",
      output: ({ context }) => ({
        outcome: "won",
        playerScore: context.playerScore,
        opponentScore: context.opponentScore,
        history: context.history,
      }),
    },
    lost: {
      type: "final",
      output: ({ context }) => ({
        outcome: "lost",
        playerScore: context.playerScore,
        opponentScore: context.opponentScore,
        history: context.history,
      }),
    },
  },
});

export async function main() {
  const executors = createAiSdkExecutors({ models: rpsModels });

  const result = await runAgent(rpsMachine, {
    input: { targetWins: 3 },
    executors,
    maxModelCalls: 30,
  });

  if (result.status !== "done") {
    throw new Error(`Match did not finish: ${result.status}`);
  }
  const { outcome, playerScore, opponentScore, history } = result.output;
  console.log(renderHistory(history));
  console.log(`\nYou ${outcome} ${playerScore}-${opponentScore}.`);
}

runExampleMain(import.meta.url, main);
