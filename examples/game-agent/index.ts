/**
 * Games as machines — two lessons in one example:
 *
 * 1. Context-computed `allowedEvents` (the combat machine, `gameMachine`): the
 *    model decides one legal move (`agent.decide`, whose chosen event is
 *    auto-delivered), the move updates HP, and a text request narrates the
 *    result. `allowedEvents` widens to include HEAL only when the player is low
 *    on HP — the legal move set is COMPUTED from context. The machine keeps a
 *    `log: string[]` blow-by-blow and its output `summary` is that narration as
 *    readable text, not a bare data dump.
 *
 * 2. Reducing the event log into context (the RPS machine, `rpsMachine`): YOU
 *    play rock-paper-scissors against the model, first to 3. Each round the
 *    machine appends both throws and the result to `context.history`, and the
 *    model's decide prompt renders that log back. The saved history is the ONLY
 *    way the model can spot your habits and counter them — context IS the
 *    agent's memory.
 *
 * Your throws are gated machine events (`HUMAN_ROCK` / `HUMAN_PAPER` /
 * `HUMAN_SCISSORS`) hinted through `meta.interaction`, so hosts and demos
 * render them as buttons: the run settles idle on `awaitingHumanThrow` and
 * resumes with `runAgent(rpsMachine, { snapshot: result.persist(), event })`.
 * `metadata.json` nominates `rpsMachine` as the machine a host should drive.
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
import {
  createAgentSchemas,
  createTextLogic,
  getStateMeta,
  runAgent,
  setupAgent,
  type AgentDecisionExecutor,
} from "@statelyai/agent";
import type { SnapshotFrom } from "xstate";

/**
 * Typed `meta.interaction` hints. Hosts read them off the idle snapshot to
 * label buttons and route free chat text to an event.
 */
const metaSchema = z.object({
  interaction: z
    .object({
      label: z.string(),
      events: z
        .record(
          z.string(),
          z.object({
            label: z.string().optional(),
            style: z.enum(["primary", "danger", "default"]).optional(),
          }),
        )
        .optional(),
      textEvent: z.string().optional(),
    })
    .optional(),
});

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
    // Blow-by-blow narration, appended as the turn plays out. The output's
    // `summary` is this log rendered as text.
    log: z.array(z.string()),
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
  model: "moveChooser" as const,
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

/** Renders the combat log plus how the encounter ended, as readable text. */
export function renderCombat(log: string[], outcome: string): string {
  const lines = log.length === 0 ? ["Nothing happened."] : log;
  const ending =
    outcome === "won"
      ? "The enemy falls. You win."
      : outcome === "lost"
        ? "You go down. The goblin wins."
        : outcome === "fled"
          ? "You break off and run."
          : "The fight goes on.";
  return [...lines, ending].join("\n");
}

// `summarizing` always sets `lastSummary` before any of these states is
// reached (either via the summarize onDone, or FLEE's own context patch), so
// it's narrowed non-null on every path in.
const nonNullSummaryContext = gameSchemas.context.extend({ lastSummary: z.string() });

const gameAgentSetup = setupAgent({
  schemas: gameSchemas,
  models,
  actors: gameActors,
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
    log: [`You face a goblin. You ${input.playerHp} HP, goblin ${input.enemyHp} HP.`],
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
        ATTACK: ({ context, event }) => {
          const enemyHp = Math.max(0, context.enemyHp - 6);
          return {
            target: "summarizing",
            context: {
              enemyHp,
              defended: false,
              log: [
                ...context.log,
                `You attack the ${event.target} for 6 (goblin ${context.enemyHp} → ${enemyHp}).`,
              ],
            },
          };
        },
        DEFEND: ({ context }) => ({
          target: "summarizing",
          context: {
            defended: true,
            log: [...context.log, "You raise your guard and brace for the next blow."],
          },
        }),
        HEAL: ({ context, event }) => {
          const playerHp = Math.min(20, context.playerHp + event.amount);
          return {
            target: "summarizing",
            context: {
              playerHp,
              defended: false,
              log: [
                ...context.log,
                `You heal ${event.amount} (you ${context.playerHp} → ${playerHp}).`,
              ],
            },
          };
        },
        FLEE: ({ context }) => ({
          target: "fled",
          context: {
            lastSummary: "You fled the encounter.",
            log: [...context.log, "You disengage and back away."],
          },
        }),
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
        onDone: ({ context, output }) => ({
          target: "checkingOutcome",
          context: {
            playerHp: output.playerHp,
            enemyHp: output.enemyHp,
            lastSummary: output.summary,
            log: [
              ...context.log,
              output.summary,
              `End of turn: you ${output.playerHp} HP, goblin ${output.enemyHp} HP.`,
            ],
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
        summary: renderCombat(context.log, "continue"),
        playerHp: context.playerHp,
        enemyHp: context.enemyHp,
      }),
    },
    won: {
      type: "final",
      output: ({ context }) => ({
        outcome: "won",
        summary: renderCombat(context.log, "won"),
        playerHp: context.playerHp,
        enemyHp: context.enemyHp,
      }),
    },
    lost: {
      type: "final",
      output: ({ context }) => ({
        outcome: "lost",
        summary: renderCombat(context.log, "lost"),
        playerHp: context.playerHp,
        enemyHp: context.enemyHp,
      }),
    },
    fled: {
      type: "final",
      output: ({ context }) => ({
        outcome: "fled",
        summary: renderCombat(context.log, "fled"),
        playerHp: context.playerHp,
        enemyHp: context.enemyHp,
      }),
    },
    // Reached when chooseMove exhausts its retries (AgentDecisionExhaustedError):
    // the decision loop stalled, so the encounter ends unresolved
    // (outcome 'continue') rather than as a win/loss/flee.
    fumbled: {
      type: "final",
      output: ({ context }) => ({
        outcome: "continue" as const,
        summary: renderCombat(
          [...context.log, "The hero fumbled and the moment passed."],
          "continue",
        ),
        log: [...context.log, "The hero fumbled and the moment passed."],
        playerHp: context.playerHp,
        enemyHp: context.enemyHp,
      }),
    },
  },
});

// ─── Lesson 2: reducing the event log into context (rock-paper-scissors) ───
//
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

export const rpsSchemas = createAgentSchemas({
  meta: metaSchema,
  context: z.object({
    targetWins: z.number(),
    round: z.number(),
    playerScore: z.number(),
    opponentScore: z.number(),
    /** Your throw for the round in progress, waiting on the model's reply. */
    pendingThrow: moveSchema.nullable(),
    /** Line shown above the buttons: what just happened. */
    notice: z.string(),
    // The event log: every round's throws and result, in order. This is what
    // the decide prompt reads to find your pattern.
    history: z.array(roundSchema),
  }),
  input: z.object({
    targetWins: z.number().default(3),
  }),
  output: z.object({
    outcome: z.enum(["won", "lost"]),
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

/** Resolves the round once both throws are in. */
function resolveRound(
  context: { round: number; history: Round[]; pendingThrow: Move | null },
  opponent: Move,
) {
  const player = context.pendingThrow ?? "rock";
  const result: Round["result"] =
    player === opponent ? "tie" : BEATS[player] === opponent ? "win" : "loss";
  const round = context.round + 1;
  return {
    target: "checkingScore" as const,
    context: {
      round,
      pendingThrow: null,
      history: [...context.history, { round, player, opponent, result }],
      notice:
        result === "tie"
          ? `Round ${round}: you both threw ${player}. Tie.`
          : `Round ${round}: you threw ${player}, the agent threw ${opponent} — you ${result === "win" ? "win" : "lose"} it.`,
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
    pendingThrow: null,
    notice: `First to ${input.targetWins} wins. Throw something.`,
    history: [],
  }),
  initial: "awaitingHumanThrow",
  states: {
    // No invoke: the run settles idle here and a host resumes with one of the
    // accepted events. `meta.interaction` labels them as buttons; `{notice}`
    // resolves against the snapshot context when the label is shown.
    awaitingHumanThrow: {
      tags: ["waiting"],
      meta: {
        interaction: {
          label: "{notice}",
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
        return {
          target,
          context: {
            playerScore,
            opponentScore,
            notice: `${context.notice} Score: you ${playerScore}, agent ${opponentScore}.`,
          },
        };
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

/** `{key}` placeholders in interaction labels resolve against context. */
export function resolveInteractionLabel(label: string, context: Record<string, unknown>): string {
  return label
    .replace(/\{(\w+)\}/g, (_, key: string) => {
      const value = context[key];
      return typeof value === "string" || typeof value === "number" ? String(value) : "";
    })
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Plays a full RPS match, settling idle on every one of your throws and
 * resuming from `result.persist()`. The test passes mock executors and
 * scripted throws, so CI stays keyless.
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
    const label = resolveInteractionLabel(
      getStateMeta(result.snapshot).interaction?.label ?? "Your throw?",
      result.snapshot.context,
    );
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
  // Lesson 1: one combat turn, decided move narrated.
  const result = await runAgent(gameMachine, {
    input: { playerHp: 20, enemyHp: 15 },
    executors: createAiSdkExecutors({ models }),
    onTransition: (snapshot) => console.log("[combat]", JSON.stringify(snapshot.value)),
  });

  if (result.status !== "done") {
    throw new Error(`Game turn did not complete: ${result.status}`);
  }
  console.log(result.output.summary);

  // Lesson 2: play the model, first to 3, off the saved event log.
  console.log("\n--- Rock-paper-scissors (event log in context) ---");
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
