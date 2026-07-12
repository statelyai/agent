/**
 * Turn-based combat agent: each turn the model decides one legal move
 * (`agent.decide`, whose chosen event is auto-delivered), the move updates HP,
 * and a text
 * request narrates the result. `allowedEvents` widens to include HEAL only
 * when the player is low on HP — the legal move set is computed from context.
 *
 * This file runs ONE turn end-to-end via `runAgent` (the machine resolves to
 * a single outcome). For the multi-turn, host-driven step loop — where the
 * host re-enters the machine each turn and owns the encounter — see
 * examples/ai-sdk-game-host, which drives this same agent with real models.
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/game-agent/index.ts
 */
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { createAiSdkExecutors, defineModels } from "../../src/ai-sdk/index.js";
import {
  createAgentSchemas,
  createTextLogic,
  runAgent,
  setupAgent,
} from "../../src/index.js";
import { runExampleMain } from "../helpers/main.js";

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

export async function main() {
  const executors = createAiSdkExecutors({ models });

  const result = await runAgent(gameMachine, {
    input: { playerHp: 20, enemyHp: 15 },
    ...executors,
    onTransition: (snapshot) => console.log("[state]", JSON.stringify(snapshot.value)),
  });

  if (result.status !== "done") {
    throw new Error(`Game turn did not complete: ${result.status}`);
  }
  const { outcome, summary, playerHp, enemyHp } = result.output;
  console.log(`Outcome: ${outcome}`);
  console.log(`Player HP: ${playerHp}  Enemy HP: ${enemyHp}`);
  console.log(summary);
}

runExampleMain(import.meta.url, main);

// ─── Type probe: compilation fails if the root/final output stops being typed ───

gameAgentSetup.createMachine({
  context: {
    playerHp: 20,
    enemyHp: 15,
    defended: false,
    lastSummary: null,
  },
  // @ts-expect-error root machine output must match gameSchemas.output
  output: () => ({ wrong: true }),
  // `fumbled` (an unnarrowed declared state) — the setup's per-state schemas
  // block constrains machines to declared state keys, so this probe machine
  // must reuse one.
  initial: "fumbled",
  states: {
    fumbled: {
      type: "final",
      // @ts-expect-error top-level final state output must match gameSchemas.output
      output: () => ({ wrong: true }),
    },
  },
});
