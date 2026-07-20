/**
 * Games as machines — two lessons in one example:
 *
 * 1. Context-computed `allowedEvents` (the combat agent, `gameMachine`): each
 *    turn the model decides one legal move (`agent.decide`, whose chosen event
 *    is auto-delivered), the move updates HP, and a text request narrates the
 *    result. `allowedEvents` widens to include HEAL only when the player is low
 *    on HP — the legal move set is COMPUTED from context.
 *
 * 2. Reducing the event log into context (the RPS agent, `rpsMachine`): the
 *    machine appends every round's throws + result to `context.history`, and
 *    the decide prompt renders that log back. The saved event history is the
 *    ONLY way the model can infer the opponent's pattern and win — context IS
 *    the agent's memory.
 *
 * The combat turn runs ONE turn end-to-end via `runAgent`. For the multi-turn,
 * host-driven step loop — where the host re-enters the machine each turn and
 * owns the encounter — see examples/ai-sdk-game-host, which drives `gameMachine`
 * with real models.
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/game-agent/index.ts
 */
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { createAiSdkExecutors, defineModels } from "@statelyai/agent/ai-sdk";
import { createAgentSchemas, createTextLogic, runAgent, setupAgent } from "@statelyai/agent";

export const turnSummarySchema = z.object({
  summary: z.string(),
  enemyHp: z.number(),
  playerHp: z.number(),
});

export const gameSchemas = createAgentSchemas({
  context: z.object({
    playerHp: z.number(),
    enemyHp: z.number(),
    defended: z.boolean(),
    lastSummary: z.string().nullable(),
  }),
  input: z.object({
    playerHp: z.number().default(20),
    enemyHp: z.number().default(15),
  }),
  output: z.object({
    outcome: z.enum(["continue", "won", "lost", "fled"]),
    summary: z.string(),
    playerHp: z.number(),
    enemyHp: z.number(),
  }),
  events: {
    ATTACK: z.object({ target: z.string().default("goblin") }),
    DEFEND: z.object({}),
    HEAL: z.object({ amount: z.number().min(1).max(8).default(4) }),
    FLEE: z.object({}),
  },
});

type GameEventType = keyof typeof gameSchemas.events;

export const models = defineModels({
  moveChooser: openai("gpt-5.4-mini"),
  turnSummarizer: openai("gpt-5.4-mini"),
});

const defaultMoveEvents = ["ATTACK", "DEFEND", "FLEE"] satisfies GameEventType[];
const lowHpMoveEvents = ["ATTACK", "DEFEND", "HEAL", "FLEE"] satisfies GameEventType[];

// Reusable decision as a shared *input builder* — a `({ context }) => AgentDecisionInput`
// function, not an actor. Drop it into any state's `agent.decide` invoke to reuse
// the same move-choosing decision. `allowedEvents` widens to include HEAL only
// when the player is low on HP.
export const chooseMoveInput = ({
  context,
}: {
  context: { playerHp: number; enemyHp: number };
}) => ({
  model: "moveChooser",
  system: "You are playing a turn-based game. Choose exactly one legal move.",
  prompt: [
    `Player HP: ${context.playerHp}`,
    `Enemy HP: ${context.enemyHp}`,
    "Pick the best legal move.",
  ].join("\n"),
  allowedEvents: context.playerHp <= 6 ? lowHpMoveEvents : defaultMoveEvents,
});

export const summarizeTurn = createTextLogic({
  schemas: {
    input: z.object({
      playerHp: z.number(),
      enemyHp: z.number(),
      defended: z.boolean(),
    }),
    output: turnSummarySchema,
  },
  model: "turnSummarizer",
  system: "Narrate the turn and return updated HP totals.",
  prompt: ({ input }) =>
    [
      `Player HP: ${input.playerHp}`,
      `Enemy HP: ${input.enemyHp}`,
      `Defended: ${input.defended}`,
    ].join("\n"),
});

export const gameActors = {
  summarizeTurn,
};

// `summarizing` always sets `lastSummary` before any of these states is
// reached (either via the summarize onDone, or FLEE's own context patch), so
// it's narrowed non-null on every path in.
const nonNullSummaryContext = gameSchemas.context.extend({ lastSummary: z.string() });

const gameAgentSetup = setupAgent({
  schemas: gameSchemas,
  models,
  actorSources: gameActors,
  states: {
    choosingMove: {},
    summarizing: {},
    checkingOutcome: {},
    done: { schemas: { context: nonNullSummaryContext } },
    won: { schemas: { context: nonNullSummaryContext } },
    lost: { schemas: { context: nonNullSummaryContext } },
    fled: { schemas: { context: nonNullSummaryContext } },
    fumbled: {},
  },
});

export const gameMachine = gameAgentSetup.createMachine({
  id: "turn-based-game-agent",
  context: ({ input }) => ({
    playerHp: input.playerHp,
    enemyHp: input.enemyHp,
    defended: false,
    lastSummary: null,
  }),
  initial: "choosingMove",
  states: {
    choosingMove: {
      invoke: {
        src: "agent.decide",
        input: chooseMoveInput,
        onError: { target: "fumbled" },
      },
      on: {
        ATTACK: ({ context }) => ({
          target: "summarizing",
          context: {
            enemyHp: Math.max(0, context.enemyHp - 6),
            defended: false,
          },
        }),
        DEFEND: {
          target: "summarizing",
          context: { defended: true },
        },
        HEAL: ({ context, event }) => ({
          target: "summarizing",
          context: {
            playerHp: Math.min(20, context.playerHp + event.amount),
            defended: false,
          },
        }),
        FLEE: {
          target: "fled",
          context: {
            lastSummary: "You fled the encounter.",
          },
        },
      },
    },
    summarizing: {
      invoke: {
        id: "summarizeTurn",
        src: "summarizeTurn",
        input: ({ context }) => ({
          playerHp: context.playerHp,
          enemyHp: context.enemyHp,
          defended: context.defended,
        }),
        onDone: ({ output }) => ({
          target: "checkingOutcome",
          context: {
            playerHp: output.playerHp,
            enemyHp: output.enemyHp,
            lastSummary: output.summary,
          },
        }),
      },
    },
    checkingOutcome: {
      type: "choice",
      choice: ({ context }) => {
        if (context.enemyHp <= 0) {
          return { target: "won" };
        }
        if (context.playerHp <= 0) {
          return { target: "lost" };
        }
        return { target: "done" };
      },
    },
    done: {
      type: "final",
      output: ({ context }) => ({
        outcome: "continue",
        summary: context.lastSummary,
        playerHp: context.playerHp,
        enemyHp: context.enemyHp,
      }),
    },
    won: {
      type: "final",
      output: ({ context }) => ({
        outcome: "won",
        summary: context.lastSummary,
        playerHp: context.playerHp,
        enemyHp: context.enemyHp,
      }),
    },
    lost: {
      type: "final",
      output: ({ context }) => ({
        outcome: "lost",
        summary: context.lastSummary,
        playerHp: context.playerHp,
        enemyHp: context.enemyHp,
      }),
    },
    fled: {
      type: "final",
      output: ({ context }) => ({
        outcome: "fled",
        summary: context.lastSummary,
        playerHp: context.playerHp,
        enemyHp: context.enemyHp,
      }),
    },
    // Reached when chooseMove exhausts its retries (DecisionExhaustedError):
    // the decision loop stalled, so the encounter ends unresolved
    // (outcome 'continue') rather than as a win/loss/flee.
    fumbled: {
      type: "final",
      output: ({ context }) => ({
        outcome: "continue" as const,
        summary: context.lastSummary ?? "The hero fumbled and the moment passed.",
        playerHp: context.playerHp,
        enemyHp: context.enemyHp,
      }),
    },
  },
});

// ─── Lesson 2: reducing the event log into context (rock-paper-scissors) ───
//
// The opponent plays a fixed repeating pattern. Every round the machine appends
// what happened — both throws and the result — to `context.history`. The decide
// prompt renders that log, so the model's only path to winning is the event
// history the machine saved: each round in isolation is a coin flip, but the
// log exposes the opponent's cycle. No runAgent plumbing needed — context IS
// the agent's memory.

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
  // Lesson 1: one combat turn, decided move narrated.
  const result = await runAgent(gameMachine, {
    input: { playerHp: 20, enemyHp: 15 },
    executors: createAiSdkExecutors({ models }),
    onTransition: (snapshot) => console.log("[combat]", JSON.stringify(snapshot.value)),
  });

  if (result.status !== "done") {
    throw new Error(`Game turn did not complete: ${result.status}`);
  }
  const { outcome, summary, playerHp, enemyHp } = result.output;
  console.log(`Outcome: ${outcome}`);
  console.log(`Player HP: ${playerHp}  Enemy HP: ${enemyHp}`);
  console.log(summary);

  // Lesson 2: a full RPS match won purely off the saved event log.
  console.log("\n--- Rock-paper-scissors (event log in context) ---");
  const rps = await runAgent(rpsMachine, {
    input: { targetWins: 3 },
    executors: createAiSdkExecutors({ models: rpsModels }),
    maxModelCalls: 30,
  });

  if (rps.status !== "done") {
    throw new Error(`Match did not finish: ${rps.status}`);
  }
  console.log(renderHistory(rps.output.history));
  console.log(`\nYou ${rps.output.outcome} ${rps.output.playerScore}-${rps.output.opponentScore}.`);
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
