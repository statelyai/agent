/**
 * The FEATURE VOCABULARY: the low-level board facts a policy conditions on.
 * The host computes them from the game's board on every O turn; a policy
 * only reads them. The list is fixed: the improver cannot add a feature, and
 * a candidate that reads any other path fails the `features` gate.
 *
 * Every feature except `board` is a sorted list of cells (ascending), so a
 * JSON template can test and index it:
 *   - `{{ context.facts.completesMyLine.length }}`: truthy when the list is non-empty
 *   - `{{ context.facts.completesMyLine.0 }}`: its first (lowest) cell
 *
 * Cells run row by row: 0 1 2 / 3 4 5 / 6 7 8.
 */
import { emptyCells, LINES, type Board, type Mark } from "./game.js";

const CORNERS = [0, 2, 6, 8];
const EDGES = [1, 3, 5, 7];

/** The features, and what each one lists. The reflection prompt shows this table verbatim. */
export const FEATURES = {
  board: "the nine cells, row by row: 'X', 'O', or null",
  empty: "empty cells",
  myCells: "cells holding my mark (O)",
  theirCells: "cells holding their mark (X)",
  completesMyLine: "empty cells where my mark completes a line of three (a win now)",
  completesTheirLine: "empty cells where their mark would complete a line of three",
  createsMyOpenTwo:
    "empty cells where my mark makes at least one line with two of mine and the third cell empty",
  createsMyFork:
    "empty cells where my mark makes two or more lines with two of mine and the third cell empty",
  createsTheirFork:
    "empty cells where their mark would make two or more lines with two of theirs and the third cell empty",
  forcesSafeBlock:
    "empty cells where my mark makes an open two (they must block its empty cell) and that blocking cell does not make a fork for them",
  center: "the center cell (4), when empty",
  corners: "empty corner cells (0, 2, 6, 8)",
  edges: "empty edge cells (1, 3, 5, 7)",
  oppositeCornerOfTheirs: "empty corners whose opposite corner holds their mark",
} as const;

export type FeatureName = keyof typeof FEATURES;
export const FEATURE_NAMES = Object.keys(FEATURES) as FeatureName[];

export type Features = { board: Board } & Record<Exclude<FeatureName, "board">, number[]>;

/** Lines through `cell` that hold two of `mark` and one empty cell once `mark` is placed there. */
function openTwosThrough(board: Board, cell: number, mark: Mark): number {
  return LINES.filter((line) => {
    if (!line.includes(cell)) return false;
    const marks = line.filter((other) => other === cell || board[other] === mark).length;
    const empty = line.filter((other) => other !== cell && board[other] === null).length;
    return marks === 2 && empty === 1;
  }).length;
}

function completesLine(board: Board, cell: number, mark: Mark): boolean {
  return LINES.some(
    (line) => line.includes(cell) && line.every((other) => other === cell || board[other] === mark),
  );
}

/** The empty cells of the open twos my mark at `cell` makes: where they must block. */
function blockingCells(board: Board, cell: number, mark: Mark): number[] {
  return LINES.flatMap((line) => {
    if (!line.includes(cell)) return [];
    const mine = line.filter((other) => other === cell || board[other] === mark).length;
    const open = line.filter((other) => other !== cell && board[other] === null);
    return mine === 2 && open.length === 1 ? open : [];
  });
}

/** The features of `board` for `me` (O by default). */
export function boardFeatures(board: Board, me: Mark = "O"): Features {
  const them: Mark = me === "O" ? "X" : "O";
  const empty = emptyCells(board);
  const where = (test: (cell: number) => boolean) => empty.filter(test);
  return {
    board,
    empty,
    myCells: board.flatMap((cell, index) => (cell === me ? [index] : [])),
    theirCells: board.flatMap((cell, index) => (cell === them ? [index] : [])),
    completesMyLine: where((cell) => completesLine(board, cell, me)),
    completesTheirLine: where((cell) => completesLine(board, cell, them)),
    createsMyOpenTwo: where((cell) => openTwosThrough(board, cell, me) >= 1),
    createsMyFork: where((cell) => openTwosThrough(board, cell, me) >= 2),
    createsTheirFork: where((cell) => openTwosThrough(board, cell, them) >= 2),
    forcesSafeBlock: where((cell) => {
      const blocks = blockingCells(board, cell, me);
      const next = board.map((mark, index) => (index === cell ? me : mark));
      return blocks.length > 0 && blocks.every((block) => openTwosThrough(next, block, them) < 2);
    }),
    center: where((cell) => cell === 4),
    corners: where((cell) => CORNERS.includes(cell)),
    edges: where((cell) => EDGES.includes(cell)),
    oppositeCornerOfTheirs: where((cell) => CORNERS.includes(cell) && board[8 - cell] === them),
  };
}
