import { describe, expect, test } from "vitest";
import { createActor } from "xstate";
import {
  createAgentRuntime,
  eventFromInteraction,
  getInteraction,
  runToQuiescence,
  type AgentDecisionExecutor,
} from "@statelyai/agent";
import { createInMemoryEventLogStore } from "@statelyai/agent/log";
import { lintAgentMachine } from "@statelyai/agent/testing";
import { boardFeatures } from "./features.js";
import { gameSnapshotAt, LINES, ticTacToeMachine, type Board, type Mark } from "./game.js";
import { decideOMove, playGame } from "./play.js";
import { seededRng } from "./opponents.js";
import { optimalCell } from "./test-doubles.js";

/** Plays `cells` alternately from X, on a bare actor. */
function playOut(cells: number[]) {
  const actor = createActor(ticTacToeMachine).start();
  cells.forEach((cell, index) => actor.send({ type: index % 2 === 0 ? "X.play" : "O.play", cell }));
  return actor.getSnapshot();
}

/** A game `winner` wins on `line`; the loser plays off the line, on cells that form no line of their own. */
function gameWonBy(winner: Mark, line: readonly number[]): number[] {
  const off = [0, 1, 2, 3, 4, 5, 6, 7, 8].filter((cell) => !line.includes(cell));
  const triples = off.flatMap((a, i) =>
    off.slice(i + 1).flatMap((b, j) => off.slice(i + j + 2).map((c) => [a, b, c])),
  );
  const filler = triples.find((t) => !LINES.some((l) => l.every((cell) => t.includes(cell))))!;
  const [a, b, c] = line as [number, number, number];
  const [f1, f2, f3] = filler as [number, number, number];
  return winner === "X" ? [a, f1, b, f2, c] : [f1, a, f2, b, f3, c];
}

describe("the game (the environment)", () => {
  test("is a plain machine that lints clean, with O's goal as its description", () => {
    expect(lintAgentMachine(ticTacToeMachine)).toEqual([]);
    expect(ticTacToeMachine.root.description).toMatch(/never lose/);
  });

  test("X moves first and the turns alternate", () => {
    const start = createActor(ticTacToeMachine).start().getSnapshot();
    expect(start.value).toBe("xTurn");
    expect(start.can({ type: "O.play", cell: 0 })).toBe(false);
    expect(start.can({ type: "X.play", cell: 0 })).toBe(true);

    const afterX = playOut([4]);
    expect(afterX.value).toBe("oTurn");
    expect(afterX.can({ type: "X.play", cell: 0 })).toBe(false);
    expect(playOut([4, 0]).value).toBe("xTurn");
  });

  test("an occupied cell is refused and changes nothing", () => {
    const actor = createActor(ticTacToeMachine).start();
    actor.send({ type: "X.play", cell: 4 });
    const before = actor.getSnapshot();
    expect(before.can({ type: "O.play", cell: 4 })).toBe(false);
    actor.send({ type: "O.play", cell: 4 });
    expect(actor.getSnapshot().value).toBe("oTurn");
    expect(actor.getSnapshot().context.board).toEqual(before.context.board);
  });

  test.each(LINES.map((line) => [line.join("-"), line] as const))(
    "line %s wins for either side",
    (_name, line) => {
      const x = playOut(gameWonBy("X", line));
      expect(x.value).toBe("xWins");
      expect(x.output?.winner).toBe("X");
      const o = playOut(gameWonBy("O", line));
      expect(o.value).toBe("oWins");
      expect(o.output?.winner).toBe("O");
    },
  );

  test("a full board with no line is a draw", () => {
    // X O X / X O O / O X X
    const done = playOut([0, 1, 2, 4, 3, 5, 7, 6, 8]);
    expect(done.value).toBe("draw");
    expect(done.output?.summary).toBe("Draw in 9 moves: X O X / X O O / O X X");
  });

  test("a person can play both sides through the interaction choices", async () => {
    const store = createInMemoryEventLogStore();
    const run = (init: Parameters<typeof runToQuiescence<typeof ticTacToeMachine>>[1]) =>
      runToQuiescence(createAgentRuntime(ticTacToeMachine, { store, threadId: "person" }), init);
    let result = await run({ input: {} });
    const first = getInteraction(result.snapshot)!;
    expect(first.label).toBe("X to move. Board: . . . / . . . / . . .");
    expect(first.choices).toHaveLength(9);

    // X center, O top left, X top right, O bottom left, X middle left, O bottom middle...
    for (const cell of [4, 0, 2, 6, 3, 5, 1, 7, 8]) {
      const interaction = getInteraction(result.snapshot)!;
      const label = interaction.choices!.find((choice) => choice.event.cell === cell)!.label;
      result = await run({ event: eventFromInteraction(result.snapshot, { choice: label }) });
      if (result.status === "done") break;
      // One button per empty cell: occupied ones are never listed.
      const board = result.snapshot.context.board;
      expect(getInteraction(result.snapshot)!.choices!.map((c) => c.event.cell)).toEqual(
        boardFeatures(board).empty,
      );
    }
    expect(result.status).toBe("done");
    expect(
      getInteraction(gameSnapshotAt(["X", null, null, null, "O", null, null, null, null]))!.label,
    ).toBe("X to move. Board: X . . / . O . / . . .");
  });
});

describe("the boundary", () => {
  test("decideNext offers O only the empty cells", async () => {
    const board: Board = ["X", null, null, null, "O", null, null, null, "X"];
    let offered: unknown[] = [];
    const decide: AgentDecisionExecutor = async (request) => {
      offered = (request.options ?? []).map((option) => option.event);
      return { event: { type: "O.play", cell: 1 } };
    };
    const { event, request } = await decideOMove(gameSnapshotAt(board), { decide });
    expect(event).toEqual({ type: "O.play", cell: 1 });
    expect(offered).toEqual([1, 2, 3, 5, 6, 7].map((cell) => ({ type: "O.play", cell })));
    expect(request.options![0]!.description).toBe("O marks an empty cell (cell: 1)");
  });

  test("a move that is not offered is refused, retried, and journaled", async () => {
    const store = createInMemoryEventLogStore();
    // First try: the center, always; then the reference move.
    const decide: AgentDecisionExecutor = async (request) => ({
      event: {
        type: "O.play",
        cell:
          request.attempts.length === 0
            ? 4
            : optimalCell((request.input as { context: { board: Board } }).context.board),
      },
    });
    const game = await playGame({
      decide,
      opponent: "random",
      rng: seededRng(1),
      store,
      threadId: "sloppy",
    });
    expect(game.rejections).toBeGreaterThan(0);
    expect(game.trail.some((line) => line.startsWith("O refused 4 (rejected-by-guard)"))).toBe(
      true,
    );
  });
});
