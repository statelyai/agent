/**
 * Vercel AI SDK host for a turn-based combat machine.
 *
 * Two things live here, and the split between them is the lesson:
 *
 * 1. The MACHINE (`gameMachine`) — provider-free. The model decides one legal
 *    move (`agent.decide`, whose chosen event is auto-delivered), the move
 *    updates HP, and a text request narrates the result. `allowedEvents` widens
 *    to include HEAL only when the player is low on HP: the legal move set is
 *    COMPUTED from context. HP goes into the narrator and never comes back out —
 *    a model that could return HP could revive the goblin.
 *
 * 2. The HOST (`runAiSdkGameTurn`) — the only part that knows about the AI SDK.
 *    It contributes `createAiSdkExecutors({ models })` and drives the run with
 *    `runAgentStream`, so it sees every transition as the turn plays out. The
 *    same machine runs unchanged on Workers AI (examples/cloudflare-workers-ai-host).
 *
 * `decide` forces a tool call, one tool per candidate event, and reads the
 * chosen event off the tool call. How the model is coerced into choosing exactly
 * one legal event is adapter business, not core's — see docs/decisions.md.
 *
 * Dual-mode: `runAiSdkHostExample(options?)` takes injectable executors (tests
 * pass mocks — CI with no API key); the direct run uses real models.
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/ai-sdk-host/index.ts
 */
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { createAiSdkExecutors, defineModels } from "@statelyai/agent/ai-sdk";
import {
  createAgentSchemas,
  createTextLogic,
  runAgentStream,
  setupAgent,
  type AgentRequestExecutors,
} from "@statelyai/agent";
import type { StateValue } from "xstate";

/**
 * The narrator returns prose and nothing else. HP is the machine's to compute:
 * a model that could return HP could rewrite state the machine owns, and one
 * bad generation would silently revive the goblin.
 */
export const turnSummarySchema = z.object({
  summary: z.string(),
});

/** Damage the player's attack deals. */
const PLAYER_DAMAGE = 6;
/** Damage the goblin's counter deals, and what it deals through a raised guard. */
const ENEMY_DAMAGE = 4;
const ENEMY_DAMAGE_BLOCKED = 2;

export const gameSchemas = createAgentSchemas({
  context: z.object({
    playerHp: z.number(),
    enemyHp: z.number(),
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
      beats: z.array(z.string()),
    }),
    output: turnSummarySchema,
  },
  name: "summarizeTurn",
  model: "turnSummarizer",
  system:
    "Narrate the turn in one or two sentences. Report no numbers of your own: " +
    "the HP totals below are already final.",
  prompt: ({ input }) =>
    [
      `What happened: ${input.beats.join(" ")}`,
      `Player HP: ${input.playerHp}`,
      `Enemy HP: ${input.enemyHp}`,
    ].join("\n"),
});

export const gameActors = {
  summarizeTurn,
};

/**
 * The goblin's counter-attack: pure arithmetic the machine owns. A downed
 * goblin swings at nothing.
 */
function enemyCounter(
  context: { playerHp: number; enemyHp: number; log: string[] },
  damage: number,
) {
  if (context.enemyHp <= 0) {
    return { target: "summarizing" as const };
  }
  const playerHp = Math.max(0, context.playerHp - damage);
  return {
    target: "summarizing" as const,
    context: {
      playerHp,
      log: [
        ...context.log,
        `The goblin hits back for ${damage} (you ${context.playerHp} → ${playerHp}).`,
      ],
    },
  };
}

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
    // The player's stance is a pair of states, not a `defended: boolean` in
    // context: the goblin's counter is resolved by whichever one it entered.
    takingHit: {},
    blockingHit: {},
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
          const enemyHp = Math.max(0, context.enemyHp - PLAYER_DAMAGE);
          return {
            target: "takingHit",
            context: {
              enemyHp,
              log: [
                ...context.log,
                `You attack the ${event.target} for ${PLAYER_DAMAGE} (goblin ${context.enemyHp} → ${enemyHp}).`,
              ],
            },
          };
        },
        DEFEND: ({ context }) => ({
          target: "blockingHit",
          context: {
            log: [...context.log, "You raise your guard and brace for the next blow."],
          },
        }),
        HEAL: ({ context, event }) => {
          const playerHp = Math.min(20, context.playerHp + event.amount);
          return {
            target: "takingHit",
            context: {
              playerHp,
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
    // The goblin's counter, resolved by the machine. Entered open, so it lands
    // in full.
    takingHit: {
      always: ({ context }) => enemyCounter(context, ENEMY_DAMAGE),
    },
    // Entered behind a raised guard, so the same counter lands for less. The
    // difference is which state the fight is in, not a flag in context.
    blockingHit: {
      always: ({ context }) => enemyCounter(context, ENEMY_DAMAGE_BLOCKED),
    },
    summarizing: {
      invoke: {
        id: "summarizeTurn",
        src: "summarizeTurn",
        // HP goes IN, never comes back out: the narrator gets the finished
        // numbers and the turn's beats, and returns prose.
        input: ({ context }) => ({
          playerHp: context.playerHp,
          enemyHp: context.enemyHp,
          beats: context.log.slice(1),
        }),
        onDone: ({ context, output }) => ({
          target: "checkingOutcome",
          context: {
            lastSummary: output.summary,
            log: [
              ...context.log,
              output.summary,
              `End of turn: you ${context.playerHp} HP, goblin ${context.enemyHp} HP.`,
            ],
          },
        }),
        onError: { target: "fumbled" },
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

// ─── The host: the only part of this file that knows about the AI SDK ───

// Adapter-provided executors. The machine above names its models symbolically
// (`defineModels` keys); this is where those refs become real AI SDK models.
const defaultExecutors = createAiSdkExecutors({ models });

/**
 * Drives one combat turn with `runAgentStream`, reporting each state the
 * machine enters as it goes. Executors are injected so tests drive the turn
 * with mocks; the direct run uses the AI SDK set above.
 */
export async function runAiSdkGameTurn(
  input: { playerHp: number; enemyHp: number } = { playerHp: 20, enemyHp: 15 },
  onStep?: (value: StateValue) => void,
  executors: AgentRequestExecutors = defaultExecutors,
) {
  for await (const event of runAgentStream(gameMachine, { input, executors })) {
    if (event.kind === "transition") onStep?.(event.value);
    if (event.kind === "done") return event.result.output;
    if (event.kind === "idle" || event.kind === "error") {
      throw new Error(`Game turn ended with ${event.kind}.`);
    }
  }
  throw new Error("Game turn ended without a result.");
}

export interface RunAiSdkHostOptions {
  input?: { playerHp: number; enemyHp: number };
  /** Injected for tests; the direct run supplies real AI SDK executors. */
  executors?: AgentRequestExecutors;
  onStep?: (value: StateValue) => void;
}

/** Runs one turn and returns its output. No API key needed when executors are injected. */
export async function runAiSdkHostExample(options: RunAiSdkHostOptions = {}) {
  return runAiSdkGameTurn(
    options.input ?? { playerHp: 20, enemyHp: 15 },
    options.onStep,
    options.executors ?? defaultExecutors,
  );
}

// Run directly (`tsx index.ts`); skipped when a test imports this module.
if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  if (!process.env.OPENAI_API_KEY) {
    console.error("Set OPENAI_API_KEY to run this example.");
    process.exit(1);
  }
  void (async () => {
    const output = await runAiSdkHostExample({
      onStep: (value) => console.log("[combat]", JSON.stringify(value)),
    });
    console.log(`\n${output?.summary}`);
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
