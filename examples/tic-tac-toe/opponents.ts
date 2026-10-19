/**
 * The X opponents: plain functions of the board, outside both the game and
 * the policy. Each picks one empty cell for X.
 *
 *   - `random`: any empty cell.
 *   - `greedy`: win if it can, else block O's win, else random.
 *   - `perfect`: minimax. Among equally good moves it picks one at random, so
 *     seeded games vary while every move stays optimal.
 */
import { emptyCells, LINES, winnerOf, type Board, type Mark } from "./game.js";

export type Rng = () => number;

/** A small seeded generator (mulberry32), so every match replays exactly. */
export function seededRng(seed: number): Rng {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export type OpponentName = "random" | "greedy" | "perfect";
export type Opponent = (board: Board, rng: Rng) => number;

const pick = (cells: readonly number[], rng: Rng) => cells[Math.floor(rng() * cells.length)]!;

/** Empty cells where `mark` would complete a line. */
export function winningCells(board: Board, mark: Mark): number[] {
  return emptyCells(board).filter((cell) =>
    LINES.some(
      (line) =>
        line.includes(cell) && line.every((other) => other === cell || board[other] === mark),
    ),
  );
}

const other = (mark: Mark): Mark => (mark === "X" ? "O" : "X");

// Minimax score for `toMove` on `board`, from X's side: a sooner win scores higher.
const memo = new Map<string, number>();
function score(board: Board, toMove: Mark): number {
  const key = `${board.map((cell) => cell ?? ".").join("")}${toMove}`;
  const cached = memo.get(key);
  if (cached !== undefined) return cached;
  const winner = winnerOf(board);
  const empty = emptyCells(board);
  let value: number;
  if (winner) value = (winner === "X" ? 1 : -1) * (10 + empty.length);
  else if (empty.length === 0) value = 0;
  else {
    const scores = empty.map((cell) =>
      score(
        board.map((mark, index) => (index === cell ? toMove : mark)),
        other(toMove),
      ),
    );
    value = toMove === "X" ? Math.max(...scores) : Math.min(...scores);
  }
  memo.set(key, value);
  return value;
}

/** X's minimax-optimal cells on `board`. */
export function perfectCells(board: Board): number[] {
  const empty = emptyCells(board);
  const scores = empty.map((cell) =>
    score(
      board.map((mark, index) => (index === cell ? "X" : mark)),
      "O",
    ),
  );
  const best = Math.max(...scores);
  return empty.filter((_, index) => scores[index] === best);
}

export const OPPONENTS: Record<OpponentName, Opponent> = {
  random: (board, rng) => pick(emptyCells(board), rng),
  greedy: (board, rng) => {
    const win = winningCells(board, "X");
    if (win.length) return pick(win, rng);
    const block = winningCells(board, "O");
    if (block.length) return pick(block, rng);
    return pick(emptyCells(board), rng);
  },
  perfect: (board, rng) => pick(perfectCells(board), rng),
};
