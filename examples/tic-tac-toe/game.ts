/**
 * The game: the ENVIRONMENT of the tic-tac-toe example.
 *
 * A plain XState machine. It imports nothing from `@statelyai/agent`: zod
 * event schemas, guards (whose turn it is, and an empty cell), and three
 * final states. Its root `description` is player O's goal, the one every O
 * policy climbs toward. Frozen: no policy or improvement round may change it.
 *
 *   xTurn ─X.play─▶ afterX ─┬─▶ xWins
 *     ▲                     ├─▶ draw
 *     │                     └─▶ oTurn ─O.play─▶ afterO ─┬─▶ oWins
 *     │                                                 ├─▶ draw
 *     └─────────────────────────────────────────────────┘
 *
 * `xTurn` and `oTurn` are ordinary idle states. Whoever drives a side sends
 * one `<side>.play { cell }`: a person through the interaction choices (one
 * button per empty cell), an opponent function, or a decider at the
 * boundary (`decideNext`, in play.ts). X moves first.
 */
import { z } from "zod";
import { setup, type SnapshotFrom } from "xstate";

/** Player O's goal: the machine's root `description`. */
export const GAME_GOAL =
  "Play O in tic-tac-toe against an X that moves first: never lose, against any opponent; " +
  "win whenever the opponent allows it.";

export type Mark = "X" | "O";
export type Cell = Mark | null;
export type Board = Cell[];

/** The eight lines, as cell indexes. Cells run row by row: 0 1 2 / 3 4 5 / 6 7 8. */
export const LINES: readonly (readonly [number, number, number])[] = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
];

export const EMPTY_BOARD: Board = Array.from({ length: 9 }, () => null);

/** The mark that owns a full line, or null. */
export function winnerOf(board: Board): Mark | null {
  for (const [a, b, c] of LINES) {
    const mark = board[a];
    if (mark && mark === board[b] && mark === board[c]) return mark;
  }
  return null;
}

/** Empty cells, ascending. */
export function emptyCells(board: Board): number[] {
  return board.flatMap((cell, index) => (cell === null ? [index] : []));
}

/** `X . O / . X . / . . .`: one row per line, `.` for empty. */
export function formatBoard(board: Board): string {
  const rows = [0, 3, 6].map((start) =>
    board
      .slice(start, start + 3)
      .map((cell) => cell ?? ".")
      .join(" "),
  );
  return rows.join(" / ");
}

const CELL_NAMES = [
  "top left",
  "top middle",
  "top right",
  "middle left",
  "center",
  "middle right",
  "bottom left",
  "bottom middle",
  "bottom right",
];

/** `4 (center)`. */
export const cellName = (cell: number) => `${cell} (${CELL_NAMES[cell] ?? "?"})`;

const markSchema = z.enum(["X", "O"]);
const cellSchema = z
  .number()
  .int()
  .min(0)
  .max(8)
  .describe("A cell index, row by row: 0 1 2 / 3 4 5 / 6 7 8");

const contextSchema = z.object({
  board: z.array(markSchema.nullable()).length(9),
  /** Every move so far, in order. */
  moves: z.array(z.object({ player: markSchema, cell: z.number() })),
});
export type GameContext = z.infer<typeof contextSchema>;

export const gameOutputSchema = z.object({
  winner: markSchema.nullable(),
  board: z.array(markSchema.nullable()),
  moves: z.array(z.object({ player: markSchema, cell: z.number() })),
  summary: z.string(),
});
export type GameOutput = z.infer<typeof gameOutputSchema>;

/**
 * State meta: the demo's interaction hints, declared here in plain zod (the
 * shape `getInteraction` reads) so the machine stays free of agent imports.
 */
const metaSchema = z.object({
  interaction: z
    .object({
      label: z.union([
        z.string(),
        z.custom<(args: { context: GameContext }) => string>(
          (value) => typeof value === "function",
        ),
      ]),
      choices: z.array(
        z.object({ label: z.string(), event: z.object({ type: z.string(), cell: z.number() }) }),
      ),
    })
    .optional(),
});

/** The game's schemas. Plain zod, read by `setup`, `decideNext`, and the verifier. */
export const ticTacToeSchemas = {
  meta: metaSchema,
  context: contextSchema,
  input: z.object({}).optional(),
  output: gameOutputSchema,
  events: {
    "X.play": z.object({ cell: cellSchema }).describe("X marks an empty cell"),
    "O.play": z.object({ cell: cellSchema }).describe("O marks an empty cell"),
  },
};

/** One button per cell for `player`; `getInteraction` keeps the ones the game accepts (empty cells on that player's turn). */
const cellChoices = (player: Mark) =>
  CELL_NAMES.map((_, cell) => ({
    label: `${player} at ${cellName(cell)}`,
    event: { type: `${player}.play` as const, cell },
  }));

/** True when `cell` is on the board and empty: the guard on both sides' moves. */
const isOpen = (context: GameContext, cell: number) =>
  Number.isInteger(cell) && context.board[cell] === null;

/** The context after `player` marks `cell`. */
function mark(context: GameContext, player: Mark, cell: number): GameContext {
  return {
    board: context.board.map((current, index) => (index === cell ? player : current)),
    moves: [...context.moves, { player, cell }],
  };
}

const output = ({ context }: { context: GameContext }): GameOutput => {
  const winner = winnerOf(context.board);
  return {
    winner,
    board: context.board,
    moves: context.moves,
    summary: `${winner ? `${winner} wins` : "Draw"} in ${context.moves.length} moves: ${formatBoard(context.board)}`,
  };
};

export const ticTacToeMachine = setup({ schemas: ticTacToeSchemas }).createMachine({
  id: "tic-tac-toe",
  description: GAME_GOAL,
  context: { board: EMPTY_BOARD, moves: [] },
  initial: "xTurn",
  states: {
    xTurn: {
      description: "X to move.",
      meta: {
        interaction: {
          label: ({ context }: { context: GameContext }) =>
            `X to move. Board: ${formatBoard(context.board)}`,
          choices: cellChoices("X"),
        },
      },
      on: {
        // Refused (undefined) unless the cell is empty: `snapshot.can` is false,
        // so decideNext never offers it and getInteraction never lists it.
        "X.play": ({ context, event }) =>
          isOpen(context, event.cell)
            ? { target: "afterX", context: mark(context, "X", event.cell) }
            : undefined,
      },
    },
    afterX: {
      type: "choice",
      choice: ({ context }) =>
        winnerOf(context.board) === "X"
          ? { target: "xWins" }
          : emptyCells(context.board).length === 0
            ? { target: "draw" }
            : { target: "oTurn" },
    },
    oTurn: {
      description: "O to move.",
      meta: {
        interaction: {
          label: ({ context }: { context: GameContext }) =>
            `O to move. Board: ${formatBoard(context.board)}`,
          choices: cellChoices("O"),
        },
      },
      on: {
        "O.play": ({ context, event }) =>
          isOpen(context, event.cell)
            ? { target: "afterO", context: mark(context, "O", event.cell) }
            : undefined,
      },
    },
    afterO: {
      type: "choice",
      choice: ({ context }) =>
        winnerOf(context.board) === "O"
          ? { target: "oWins" }
          : emptyCells(context.board).length === 0
            ? { target: "draw" }
            : { target: "xTurn" },
    },
    xWins: { type: "final", description: "X completed a line: O lost.", output },
    oWins: { type: "final", description: "O completed a line.", output },
    draw: { type: "final", description: "The board is full with no line.", output },
  },
});

export type GameSnapshot = SnapshotFrom<typeof ticTacToeMachine>;

/** A game snapshot resting on `board`, on whichever side's turn it is (X when the counts are equal). */
export function gameSnapshotAt(board: Board): GameSnapshot {
  const xs = board.filter((cell) => cell === "X").length;
  const os = board.filter((cell) => cell === "O").length;
  const moves = board.flatMap((cell, index) => (cell ? [{ player: cell, cell: index }] : []));
  return ticTacToeMachine.resolveState({
    value: xs > os ? "oTurn" : "xTurn",
    context: { board, moves },
  });
}
