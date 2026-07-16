/**
 * Go Fish — hidden information + model decisions + machine-enforced rules.
 *
 * The model sees its hand, public books, and request history, but never the
 * human's hand. It chooses AGENT_ASK; the machine rejects ranks it does not
 * hold, transfers cards, draws from a deterministic deck, forms books, and
 * alternates turns. The human's turn uses `agent.userInput` and shows their
 * current hand.
 *
 * This uses a compact deck (A–6, four of each) so a CLI game finishes quickly.
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/go-fish/index.ts
 */
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import { createAiSdkExecutors, defineModels } from "../../src/ai-sdk/index.js";
import { createAgentSchemas, runAgent, setupAgent } from "../../src/index.js";
import { promptLine } from "../helpers/cli.js";
import { runExampleMain } from "../helpers/main.js";

export const ranks = ["A", "2", "3", "4", "5", "6"] as const;
const rankSchema = z.enum(ranks);
export type Rank = z.infer<typeof rankSchema>;

const turnSchema = z.object({
  player: z.enum(["agent", "human"]),
  rank: rankSchema,
  result: z.enum(["caught", "fished", "lucky"]),
  count: z.number(),
});

export const goFishSchemas = createAgentSchemas({
  context: z.object({
    deck: z.array(rankSchema),
    agentHand: z.array(rankSchema),
    humanHand: z.array(rankSchema),
    agentBooks: z.array(rankSchema),
    humanBooks: z.array(rankSchema),
    history: z.array(turnSchema),
    pendingHumanRank: z.string().nullable(),
    notice: z.string(),
    turn: z.enum(["agent", "human"]),
    turns: z.number(),
    maxTurns: z.number(),
  }),
  input: z.object({
    seed: z.number().int().default(7),
    maxTurns: z.number().int().positive().default(100),
    deck: z.array(rankSchema).optional(),
  }),
  output: z.object({
    winner: z.enum(["agent", "human", "tie"]),
    agentBooks: z.array(rankSchema),
    humanBooks: z.array(rankSchema),
    turns: z.number(),
    reason: z.enum(["all-books", "empty-hand", "turn-limit", "decision-failed"]),
  }),
  events: {
    AGENT_ASK: z.object({ rank: rankSchema }),
  },
});

const models = defineModels({ player: openai("gpt-5.4-mini") });

function shuffledDeck(seed: number): Rank[] {
  const deck = ranks.flatMap((rank) => [rank, rank, rank, rank]);
  let state = seed >>> 0;
  for (let index = deck.length - 1; index > 0; index--) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const swapIndex = state % (index + 1);
    [deck[index], deck[swapIndex]] = [deck[swapIndex]!, deck[index]!];
  }
  return deck;
}

function takeBooks(hand: Rank[], books: Rank[]) {
  let nextHand = [...hand];
  const nextBooks = [...books];
  for (const rank of ranks) {
    if (nextHand.filter((card) => card === rank).length === 4) {
      nextHand = nextHand.filter((card) => card !== rank);
      nextBooks.push(rank);
    }
  }
  return { hand: nextHand, books: nextBooks };
}

function refill(hand: Rank[], deck: Rank[]) {
  if (hand.length > 0 || deck.length === 0) return { hand, deck };
  const count = Math.min(5, deck.length);
  return { hand: deck.slice(0, count), deck: deck.slice(count) };
}

interface GameContext {
  deck: Rank[];
  agentHand: Rank[];
  humanHand: Rank[];
  agentBooks: Rank[];
  humanBooks: Rank[];
  history: z.infer<typeof turnSchema>[];
  pendingHumanRank: string | null;
  notice: string;
  turn: "agent" | "human";
  turns: number;
  maxTurns: number;
}

function settle(context: GameContext): GameContext {
  const agent = takeBooks(context.agentHand, context.agentBooks);
  const human = takeBooks(context.humanHand, context.humanBooks);
  const agentRefill = refill(agent.hand, context.deck);
  const humanRefill = refill(human.hand, agentRefill.deck);
  return {
    ...context,
    deck: humanRefill.deck,
    agentHand: agentRefill.hand,
    humanHand: humanRefill.hand,
    agentBooks: agent.books,
    humanBooks: human.books,
  };
}

function deal(deck: Rank[], maxTurns: number): GameContext {
  return settle({
    agentHand: deck.slice(0, 7),
    humanHand: deck.slice(7, 14),
    deck: deck.slice(14),
    agentBooks: [],
    humanBooks: [],
    history: [],
    pendingHumanRank: null,
    notice: "Game started. Agent goes first.",
    turn: "agent",
    turns: 0,
    maxTurns,
  });
}

function playAsk(context: GameContext, player: "agent" | "human", rank: Rank) {
  const askerKey = player === "agent" ? "agentHand" : "humanHand";
  const targetKey = player === "agent" ? "humanHand" : "agentHand";
  const matches = context[targetKey].filter((card) => card === rank);
  const targetHand = context[targetKey].filter((card) => card !== rank);
  let askerHand = [...context[askerKey]];
  let deck = [...context.deck];
  let result: "caught" | "fished" | "lucky";
  let notice: string;
  const playerName = player === "agent" ? "Agent" : "You";

  if (matches.length > 0) {
    askerHand.push(...matches);
    result = "caught";
    notice = `${playerName} asked for ${rank} and received ${matches.length}.`;
  } else {
    const drawn = deck.shift();
    if (drawn) askerHand.push(drawn);
    const lucky = drawn === rank;
    result = lucky ? "lucky" : "fished";
    notice = drawn
      ? `${playerName} asked for ${rank} and went fish${lucky ? `, drawing ${rank}` : player === "human" ? `, drawing ${drawn}` : ""}.`
      : `${playerName} asked for ${rank}; the deck was empty.`;
  }

  return settle({
    ...context,
    [askerKey]: askerHand,
    [targetKey]: targetHand,
    deck,
    pendingHumanRank: null,
    notice,
    turns: context.turns + 1,
    history: [...context.history, { player, rank, result, count: matches.length }],
  });
}

function gameOver(context: GameContext) {
  return (
    context.agentBooks.length + context.humanBooks.length === ranks.length ||
    context.turns >= context.maxTurns ||
    (context.deck.length === 0 &&
      (context.agentHand.length === 0 || context.humanHand.length === 0))
  );
}

function finalOutput(context: GameContext, reason?: "decision-failed") {
  const winner =
    context.agentBooks.length === context.humanBooks.length
      ? "tie"
      : context.agentBooks.length > context.humanBooks.length
        ? "agent"
        : "human";
  const endedBecause =
    reason ??
    (context.turns >= context.maxTurns
      ? "turn-limit"
      : context.agentBooks.length + context.humanBooks.length === ranks.length
        ? "all-books"
        : "empty-hand");
  return {
    winner,
    agentBooks: context.agentBooks,
    humanBooks: context.humanBooks,
    turns: context.turns,
    reason: endedBecause,
  } as const;
}

function parseRank(raw: string): Rank | undefined {
  const normalized = raw.trim().toUpperCase();
  return ranks.find((rank) => rank === normalized);
}

function renderAgentPrompt(context: GameContext) {
  return [
    `Your hand: ${context.agentHand.join(" ")}`,
    `Your books: ${context.agentBooks.join(" ") || "none"}`,
    `Human cards: ${context.humanHand.length}`,
    `Human books: ${context.humanBooks.join(" ") || "none"}`,
    `Deck cards: ${context.deck.length}`,
    `Public history: ${JSON.stringify(context.history)}`,
    "Ask for one rank present in your hand. Infer likely ranks from prior requests.",
  ].join("\n");
}

function renderHumanPrompt(context: GameContext) {
  return [
    context.notice,
    `Your hand: ${context.humanHand.join(" ")}`,
    `Your books: ${context.humanBooks.join(" ") || "none"}`,
    `Agent cards: ${context.agentHand.length}; agent books: ${context.agentBooks.join(" ") || "none"}`,
    `Deck cards: ${context.deck.length}`,
    `Public history: ${JSON.stringify(context.history)}`,
    "Ask for a rank in your hand:",
  ].join("\n");
}

export const goFishMachine = setupAgent({
  schemas: goFishSchemas,
  models,
}).createMachine({
  id: "go-fish",
  context: ({ input }) => deal(input.deck ?? shuffledDeck(input.seed), input.maxTurns),
  initial: "checkingWin",
  states: {
    checkingWin: {
      type: "choice",
      choice: ({ context }) =>
        gameOver(context)
          ? { target: "finished" }
          : { target: context.turn === "agent" ? "agentTurn" : "humanTurn" },
    },
    agentTurn: {
      invoke: {
        src: "agent.decide",
        input: ({ context }) => ({
          model: "player",
          system:
            "You are playing Go Fish against a human. Choose exactly one legal request. " +
            "Never claim knowledge of hidden cards.",
          prompt: renderAgentPrompt(context),
          maxRetries: 2,
        }),
        onError: { target: "decisionFailed" },
      },
      on: {
        AGENT_ASK: ({ context, event }) => {
          if (!context.agentHand.includes(event.rank)) return undefined;
          return {
            target: "checkingWin",
            context: { ...playAsk(context, "agent", event.rank), turn: "human" },
          };
        },
      },
    },
    humanTurn: {
      invoke: {
        src: "agent.userInput",
        input: ({ context }) => ({ prompt: renderHumanPrompt(context) }),
        onDone: ({ output }) => ({
          target: "resolvingHumanAsk",
          context: { pendingHumanRank: output },
        }),
      },
    },
    resolvingHumanAsk: {
      type: "choice",
      choice: ({ context }) => {
        const rank = parseRank(context.pendingHumanRank ?? "");
        if (!rank || !context.humanHand.includes(rank)) {
          return {
            target: "humanTurn",
            context: {
              pendingHumanRank: null,
              notice: `Invalid rank. Choose one of: ${[...new Set(context.humanHand)].join(" ")}.`,
            },
          };
        }
        return {
          target: "checkingWin",
          context: { ...playAsk(context, "human", rank), turn: "agent" },
        };
      },
    },
    finished: {
      type: "final",
      output: ({ context }) => finalOutput(context),
    },
    decisionFailed: {
      type: "final",
      output: ({ context }) => finalOutput(context, "decision-failed"),
    },
  },
});

export async function main() {
  let lastNotice = "";
  const result = await runAgent(goFishMachine, {
    input: { seed: 7, maxTurns: 100 },
    executors: createAiSdkExecutors({ models }),
    userInput: async ({ prompt }) => promptLine(`${prompt ?? ">"} `),
    onTransition: (snapshot) => {
      if (snapshot.context.notice !== lastNotice) {
        lastNotice = snapshot.context.notice;
        console.log(`[game] ${lastNotice}`);
      }
    },
  });

  if (result.status !== "done") throw new Error(`Go Fish did not complete: ${result.status}`);
  console.log(result.output);
}

runExampleMain(import.meta.url, main);
