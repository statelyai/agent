/**
 * The PROOF: does a policy ever lose, against ANY X?
 *
 * No copy of the game is built. `canReach` explores the real
 * `ticTacToeMachine`, and its `payloads` table decides what each side may
 * do at every idle turn:
 *
 *   - `X.play`: every empty cell. X is the adversary, so every move is a branch.
 *   - `O.play`: exactly one cell, the policy's move on this board, computed
 *     synchronously (`policyMove`). O is not a branch point that can go wrong
 *     somewhere else: it is the policy.
 *
 * `dedupeBy` keys a snapshot by its state and board, the only things the
 * guards, choice states, and the policy read, so each position is expanded
 * once. With `maxDepth: 9` (a game has at most nine moves) the search ends in
 * a final state on every path, so `complete: true` makes
 * `reachable: false` a proof: no sequence of X moves reaches `xWins`. When
 * it is reachable, the witness is the shortest losing game (`canReach`
 * searches breadth first).
 *
 * One trap is closed by hand: a policy that outputs an occupied cell would
 * have its only O branch pruned by the guard, and a pruned branch ends the
 * path without reaching `xWins`. So the payloads closure records every
 * illegal or failing policy call, and any such call refutes the policy.
 *
 * `countLosingLines` runs the same table through `explorePaths` without
 * deduplication: the number of distinct X move sequences that beat the
 * policy. It is the gradient the improvement loop climbs before any policy
 * is proven.
 */
import type { AnyMachineSnapshot, AnyStateMachine } from "xstate";
import type { ChosenEvent } from "@statelyai/agent";
import { canReach, explorePaths, type ExplorePathsOptions } from "@statelyai/agent/testing";
import { emptyCells, formatBoard, ticTacToeMachine, type Board } from "./game.js";
import { policyMove } from "./policy.js";

export type IllegalMove = { board: Board; problem: string };

/** The exploration options for `policy`: X over every empty cell, O over the policy's one move. */
function proofOptions(policy: AnyStateMachine, illegal: IllegalMove[]): ExplorePathsOptions {
  return {
    payloads: (snapshot: AnyMachineSnapshot) => {
      const board = (snapshot.context as { board: Board }).board;
      const xMoves = emptyCells(board).map((cell) => ({ cell }));
      if (!snapshot.matches("oTurn")) return { "X.play": xMoves, "O.play": [] };
      try {
        const { cell } = policyMove(policy, board);
        if (board[cell] !== null) {
          illegal.push({ board, problem: `plays occupied cell ${cell}` });
          return { "X.play": [], "O.play": [] };
        }
        return { "X.play": [], "O.play": [{ cell }] };
      } catch (error) {
        illegal.push({ board, problem: error instanceof Error ? error.message : String(error) });
        return { "X.play": [], "O.play": [] };
      }
    },
    maxDepth: 9,
    maxPaths: 100_000,
  };
}

const positionKey = (snapshot: AnyMachineSnapshot) =>
  JSON.stringify([snapshot.value, (snapshot.context as { board: Board }).board]);

export type ProofResult = {
  /** True only when the search is complete, finds no `xWins`, and the policy always made a legal move. */
  neverLoses: boolean;
  reachable: boolean;
  complete: boolean;
  /** The shortest losing game, X and O moves interleaved, when `xWins` is reachable. */
  witness?: ChosenEvent[];
  /** `X 0, O 1, X 4, O 2, X 8` and the final board, when reachable. */
  witnessText?: string;
  /** Boards where the policy threw or played an occupied cell. */
  illegal: IllegalMove[];
  ms: number;
};

/** `canReach(ticTacToeMachine, "xWins", ...)` with the policy playing O. */
export async function provePolicy(policy: AnyStateMachine): Promise<ProofResult> {
  const illegal: IllegalMove[] = [];
  const started = performance.now();
  const result = await canReach(ticTacToeMachine, "xWins", {
    ...proofOptions(policy, illegal),
    dedupeBy: positionKey,
  });
  const ms = performance.now() - started;
  return {
    neverLoses: !result.reachable && result.complete && illegal.length === 0,
    reachable: result.reachable,
    complete: result.complete,
    ...(result.witness ? { witness: result.witness, witnessText: formatGame(result.witness) } : {}),
    illegal,
    ms,
  };
}

export type LosingLines = {
  /** Distinct X move sequences that end in `xWins`. */
  count: number;
  /** Up to `keep` of them, shortest first. */
  examples: ChosenEvent[][];
  complete: boolean;
  illegal: IllegalMove[];
  ms: number;
};

/** Every game X wins against `policy`: `explorePaths` over the full tree, no deduplication. */
export async function countLosingLines(policy: AnyStateMachine, keep = 3): Promise<LosingLines> {
  const illegal: IllegalMove[] = [];
  const started = performance.now();
  const report = await explorePaths(ticTacToeMachine, proofOptions(policy, illegal));
  const losing = report.terminals
    .filter((terminal) => terminal.status === "done" && terminal.state === "xWins")
    .map((terminal) => terminal.path)
    .sort((a, b) => a.length - b.length);
  return {
    count: losing.length,
    examples: losing.slice(0, keep),
    complete:
      !report.hitPathCap &&
      report.unexpandedEvents.length === 0 &&
      report.terminals.every((terminal) => terminal.status === "done"),
    illegal,
    ms: performance.now() - started,
  };
}

/** `X 4, O 0, X 1, O 2, X 7 → X . O / . X . / . X .`: a game's moves and its final board. */
export function formatGame(path: readonly ChosenEvent[]): string {
  const board: Board = Array.from({ length: 9 }, () => null);
  const moves = path.map((event) => {
    const [mark] = event.type.split(".") as ["X" | "O"];
    const cell = (event as { cell?: number }).cell ?? -1;
    board[cell] = mark;
    return `${mark} ${cell}`;
  });
  return `${moves.join(", ")} → ${formatBoard(board)}`;
}
