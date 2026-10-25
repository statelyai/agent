/**
 * The HOST: plays games on the plain game machine, with O's decider at the
 * boundary and an X opponent function.
 *
 * Each game runs `ticTacToeMachine` through `createAgentRuntime` with an
 * event-log store, one thread per game, and `runAgent` until it is
 * done. Whenever the game idles:
 *   - in `xTurn`, the opponent picks a cell and the host sends `X.play`;
 *   - in `oTurn`, the host calls `decideNext` with `allowedEvents: ["O.play"]`
 *     and one payload per empty cell (a closed choice), and sends the chosen
 *     event with its refused `attempts`, journaled on the event's entry.
 *
 * The decider is any decide executor: a raw model, a decision model (Jev),
 * or a JSON policy (policy.ts). It never sees an occupied cell as an option.
 */
import {
  AgentDecisionExhaustedError,
  decideNext,
  type AgentDecisionExecutor,
  type AgentEventLogStore,
  type AgentLogEntry,
  type ChosenEvent,
  type AgentRunInit,
  type DecisionAttempt,
  runAgent,
} from "@statelyai/agent";
import { createInMemoryEventLogStore, getDecisionAttempts } from "@statelyai/agent/log";
import { boardFeatures } from "./features.js";
import { emptyCells, formatBoard, ticTacToeMachine, type GameSnapshot, type Mark } from "./game.js";
import { OPPONENTS, seededRng, type OpponentName, type Rng } from "./opponents.js";

/** The model ref every O decider is asked under. Hosts map it in their models map. */
export const PLAYER_MODEL = "player";

/** The decider's system prompt: the goal, read off the machine. */
export const PLAYER_SYSTEM_PROMPT = [
  `Goal: ${ticTacToeMachine.root.description}`,
  "You are O. Cells run row by row: 0 1 2 / 3 4 5 / 6 7 8. Every option is an empty cell; " +
    "choose the one that moves toward the goal.",
].join("\n");

/** The decider's prompt: the board, and the cells that win or block now. */
export function boardPrompt(snapshot: GameSnapshot): string {
  const { board } = snapshot.context;
  const features = boardFeatures(board);
  const list = (cells: number[]) => cells.join(", ") || "(none)";
  return [
    `Board: ${formatBoard(board)}`,
    `Empty cells: ${list(features.empty)}`,
    `Your cells (O): ${list(features.myCells)}. Their cells (X): ${list(features.theirCells)}.`,
  ].join("\n");
}

/**
 * The boundary call: one `decideNext` closed choice over O's legal moves.
 * Throws `AgentDecisionExhaustedError` when the decider keeps missing them.
 */
export function decideOMove(
  snapshot: GameSnapshot,
  options: { decide: AgentDecisionExecutor; name?: string; lookahead?: boolean },
) {
  return decideNext(snapshot, {
    decide: options.decide,
    model: PLAYER_MODEL,
    name: options.name ?? "player",
    allowedEvents: ["O.play"],
    payloads: (s) => ({ "O.play": emptyCells(s.context.board).map((cell) => ({ cell })) }),
    system: PLAYER_SYSTEM_PROMPT,
    prompt: boardPrompt(snapshot),
    lookahead: options.lookahead ? ["board"] : false,
  });
}

export type GameOutcome = "win" | "draw" | "loss";

export type GameResult = {
  opponent: OpponentName;
  threadId: string;
  /** From O's side. A forfeit (the decider found no legal move) is a loss. */
  outcome: GameOutcome;
  forfeit: boolean;
  /** `X 4, O 0, ...`, read back from the thread. */
  trail: string[];
  /** Refused O choices, counted from the thread. */
  rejections: number;
};

export type PlayGameOptions = {
  /** O's decider. */
  decide: AgentDecisionExecutor;
  opponent: OpponentName;
  rng: Rng;
  store: AgentEventLogStore;
  threadId: string;
  name?: string;
  lookahead?: boolean;
};

/** One game, journaled to `store` under `threadId` (which must be unused). */
export async function playGame(options: PlayGameOptions): Promise<GameResult> {
  const { store, threadId } = options;
  const opponent = OPPONENTS[options.opponent];
  const run = (init: AgentRunInit<typeof ticTacToeMachine>) =>
    runAgent(ticTacToeMachine, { store, threadId, ...init });

  let result = await run({ input: {} });
  let forfeit = false;
  while (result.status === "idle") {
    const snapshot = result.snapshot;
    if (snapshot.matches("xTurn")) {
      const cell = opponent(snapshot.context.board, options.rng);
      result = await run({ event: { type: "X.play", cell } });
      continue;
    }
    let attempts: DecisionAttempt[] = [];
    let event: ChosenEvent | null;
    try {
      const decision = await decideOMove(snapshot, options);
      attempts = decision.attempts;
      event = decision.event;
    } catch (error) {
      if (!(error instanceof AgentDecisionExhaustedError)) throw error;
      event = null;
    }
    if (!event) {
      forfeit = true;
      break;
    }
    result = await run({ event: event as { type: "O.play"; cell: number }, attempts });
  }
  let winner: Mark | null = "X";
  if (!forfeit) {
    if (result.status !== "done") {
      const why = result.status === "error" ? `: ${String(result.error)}` : "";
      throw new Error(`tic-tac-toe: game ${threadId} ended '${result.status}'${why}`);
    }
    winner = result.output.winner;
  }
  const entries = await store.read(threadId);
  return {
    opponent: options.opponent,
    threadId,
    outcome: winner === "O" ? "win" : winner === "X" ? "loss" : "draw",
    forfeit,
    trail: trailFromLog(entries),
    rejections: getDecisionAttempts(entries).reduce((n, e) => n + e.attempts.length, 0),
  };
}

/** One game's moves, projected from its thread, with any refused O choices before the move they precede. */
export function trailFromLog(entries: readonly AgentLogEntry[]): string[] {
  const refused = new Map(getDecisionAttempts(entries).map((e) => [e.index, e.attempts]));
  const trail: string[] = [];
  for (const { event, index } of entries) {
    const cell = (event as { cell?: unknown }).cell;
    if (event.type !== "X.play" && event.type !== "O.play") continue;
    for (const attempt of refused.get(index) ?? []) {
      const tried = (attempt.event as { cell?: unknown } | undefined)?.cell;
      trail.push(
        `O refused ${tried === undefined ? "(no move)" : String(tried)} (${attempt.failure})`,
      );
    }
    trail.push(`${event.type[0]} ${String(cell)}`);
  }
  return trail;
}

/** Games per opponent in a match. Fixed: every arm and round plays the same seeded games. */
export const MATCH_GAMES: Record<OpponentName, number> = { random: 20, greedy: 20, perfect: 5 };
export const MATCH_SEED = 7;

export type Tally = { wins: number; draws: number; losses: number; forfeits: number };
export type MatchResult = {
  label: string;
  byOpponent: Record<OpponentName, Tally>;
  games: GameResult[];
};

export type MatchOptions = {
  label: string;
  decide: AgentDecisionExecutor;
  /** Thread ids are `<threadPrefix>/<opponent>/<game>`. */
  threadPrefix: string;
  store?: AgentEventLogStore;
  games?: Partial<Record<OpponentName, number>>;
  seed?: number;
  name?: string;
  lookahead?: boolean;
};

const tally = (games: GameResult[]): Tally => ({
  wins: games.filter((g) => g.outcome === "win").length,
  draws: games.filter((g) => g.outcome === "draw").length,
  losses: games.filter((g) => g.outcome === "loss").length,
  forfeits: games.filter((g) => g.forfeit).length,
});

/**
 * Plays the fixed seeded match: `games[opponent]` games against each
 * opponent, game `n` of each seeded with `seed + n`, so any two deciders
 * meet the same X moves wherever their boards agree.
 */
export async function playMatch(options: MatchOptions): Promise<MatchResult> {
  const store = options.store ?? createInMemoryEventLogStore();
  const counts = { ...MATCH_GAMES, ...options.games };
  const seed = options.seed ?? MATCH_SEED;
  const games: GameResult[] = [];
  const byOpponent = {} as Record<OpponentName, Tally>;
  for (const opponent of Object.keys(OPPONENTS) as OpponentName[]) {
    const played: GameResult[] = [];
    for (let n = 0; n < counts[opponent]; n++) {
      played.push(
        await playGame({
          decide: options.decide,
          opponent,
          rng: seededRng(seed + n),
          store,
          threadId: `${options.threadPrefix}/${opponent}/${n}`,
          ...(options.name ? { name: options.name } : {}),
          ...(options.lookahead ? { lookahead: true } : {}),
        }),
      );
    }
    byOpponent[opponent] = tally(played);
    games.push(...played);
  }
  return { label: options.label, byOpponent, games };
}
