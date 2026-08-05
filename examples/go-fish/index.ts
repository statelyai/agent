/**
 * Go Fish — hidden information + model decisions + machine-enforced rules.
 *
 * The model sees its hand, public books, and request history, but never the
 * human's hand. It chooses AGENT_ASK; the machine rejects ranks it does not
 * hold, transfers cards, draws from a deterministic deck, forms books, and
 * alternates turns.
 *
 * Interaction model: the human's turn is a plain idle state (no invoke). The
 * run settles there and a host resumes it with a real machine event —
 * `ASK { rank }` — carrying the typed rank. The state's `meta.interaction`
 * tells the host how to render it: a label with `{handSummary}` interpolated
 * from context, and `textEvent: "ASK"` so free chat text becomes the event's
 * single string field. Illegal asks (a rank not in the human's hand) return
 * `undefined` from the transition, so the machine simply stays idle — the same
 * guard pattern that rejects the agent's illegal `AGENT_ASK`.
 *
 * Resume with `runAgent(machine, { snapshot: result.persistedSnapshot, event })`.
 *
 * This uses a compact deck (A–6, four of each) so a CLI game finishes quickly.
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/go-fish/index.ts
 */
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import type { SnapshotFrom } from "xstate";
import { createAiSdkExecutors, defineModels } from "@statelyai/agent/ai-sdk";
import {
  createAgentSchemas,
  getStateMeta,
  runAgent,
  setupAgent,
  type AgentDecisionExecutor,
} from "@statelyai/agent";

export const ranks = ["A", "2", "3", "4", "5", "6"] as const;
const rankSchema = z.enum(ranks);
export type Rank = z.infer<typeof rankSchema>;

const turnSchema = z.object({
  player: z.enum(["agent", "human"]),
  rank: rankSchema,
  result: z.enum(["caught", "fished", "lucky"]),
  count: z.number(),
});

/**
 * Typed `meta.interaction` hints. Hosts read them off the idle snapshot to
 * label the prompt and route free chat text to an event.
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

export const goFishSchemas = createAgentSchemas({
  meta: metaSchema,
  context: z.object({
    deck: z.array(rankSchema),
    agentHand: z.array(rankSchema),
    humanHand: z.array(rankSchema),
    agentBooks: z.array(rankSchema),
    humanBooks: z.array(rankSchema),
    history: z.array(turnSchema),
    /** Rendered human hand, interpolated into the interaction label. */
    handSummary: z.string(),
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
    /** The human's ask, sent by a host as free text ("3", "a", "ace"). */
    ASK: z.object({ rank: z.string() }),
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
  handSummary: string;
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
    handSummary: humanRefill.hand.join(" ") || "(empty)",
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
    handSummary: "",
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

/** Free text ("3", " a ", "ace") to a rank, if it names one. */
function parseRank(raw: string): Rank | undefined {
  const normalized = raw.trim().toUpperCase();
  if (normalized === "ACE") return "A";
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

export const goFishMachine = setupAgent({
  schemas: goFishSchemas,
  models,
  // Deterministic idle detection: the run settles whenever it is waiting on the
  // human, instead of falling back to the timing heuristic.
  isSuspended: (snapshot) => snapshot.hasTag("waiting"),
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
    // No invoke: the run settles idle here and a host resumes it with `ASK`.
    humanTurn: {
      tags: ["waiting"],
      meta: {
        interaction: {
          label: "Your hand: {handSummary}. Ask for a rank.",
          textEvent: "ASK",
          events: { ASK: { label: "Ask", style: "primary" } },
        },
      },
      on: {
        // Illegal asks (unknown rank, or one not in hand) are rejected the same
        // way the agent's are: the transition returns `undefined`.
        ASK: ({ context, event }) => {
          const rank = parseRank(event.rank);
          if (!rank || !context.humanHand.includes(rank)) return undefined;
          return {
            target: "checkingWin",
            context: { ...playAsk(context, "human", rank), turn: "agent" },
          };
        },
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

type GoFishSnapshot = SnapshotFrom<typeof goFishMachine>;

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

/** The label a host shows on an idle human turn. */
export function idleLabel(snapshot: GoFishSnapshot): string {
  const interaction = getStateMeta(snapshot).interaction;
  return resolveInteractionLabel(interaction?.label ?? "Ask for a rank.", snapshot.context);
}

/**
 * Dual-mode runner: the test injects a decide executor and scripted asks (so CI
 * stays keyless); the direct run below uses a real model and stdin.
 */
export async function runGoFishExample(options?: {
  input?: { seed?: number; maxTurns?: number; deck?: Rank[] };
  decide?: AgentDecisionExecutor;
  /** Scripted human asks, consumed in order on each idle settle. */
  asks?: string[];
  /** Or decide per idle snapshot; falls back to `asks`, then stdin. */
  nextAsk?: (snapshot: GoFishSnapshot) => string | undefined;
  onNotice?: (notice: string) => void;
}) {
  let lastNotice = "";
  const queued = [...(options?.asks ?? [])];

  const shared = {
    executors: options?.decide
      ? { decide: options.decide }
      : createAiSdkExecutors({ models }),
    onTransition: (snapshot: GoFishSnapshot) => {
      if (snapshot.context.notice !== lastNotice) {
        lastNotice = snapshot.context.notice;
        options?.onNotice?.(lastNotice);
      }
    },
  };

  let result = await runAgent(goFishMachine, {
    input: {
      seed: options?.input?.seed ?? 7,
      maxTurns: options?.input?.maxTurns ?? 100,
      ...(options?.input?.deck ? { deck: options.input.deck } : {}),
    },
    ...shared,
  });

  // Each human turn settles the run idle. Resume from `persistedSnapshot`.
  while (result.status === "idle") {
    const rank =
      options?.nextAsk?.(result.snapshot) ??
      queued.shift() ??
      (await promptLine(`${idleLabel(result.snapshot)}\n> `));
    result = await runAgent(goFishMachine, {
      snapshot: result.persistedSnapshot,
      event: { type: "ASK", rank },
      ...shared,
    });
  }

  if (result.status !== "done") throw new Error(`Go Fish did not complete: ${result.status}`);
  return result.output;
}

export async function main() {
  const output = await runGoFishExample({
    onNotice: (notice) => console.log(`[game] ${notice}`),
  });
  console.log(output);
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
