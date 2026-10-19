import { describe, expect, test } from "vitest";
import { createMockJudge } from "../mock-judge.js";
import { createMockModelExecutors, type MockDecisionEntry } from "../mock-model.js";
import { formatReport, runBenchmark } from "./benchmark.js";
import { boardFeatures } from "./features.js";
import type { Board } from "./game.js";
import { boardOf } from "./policy.js";
import { CLIMB } from "./test-doubles.js";

/** A plausible raw model: the center when it is free, else the first cell offered. */
const centerThenFirst: MockDecisionEntry = (request) => {
  const cells = (request.options ?? []).map(({ event }) =>
    Number((event as { cell?: unknown }).cell),
  );
  return { type: "O.play", cell: cells.includes(4) ? 4 : cells[0]! };
};

/** A mock Jev that answers the closed choice (`next`) by label: win, else block, else the first option. */
function jevJudge() {
  return createMockJudge({
    next: (state, question) => {
      const labels = Object.keys((question as { criteria: Record<string, string> }).criteria);
      const features = boardFeatures((state as { context: { board: Board } }).context.board);
      const cell = features.completesMyLine[0] ?? features.completesTheirLine[0];
      return labels.find((label) => label === `O.play:${cell}`) ?? labels[0]!;
    },
  });
}

describe("runBenchmark", () => {
  test(
    "end to end with mocks: model arms, v0, and every promoted round",
    { timeout: 60_000 },
    async () => {
      const lines: string[] = [];
      const model = createMockModelExecutors({
        decisions: { player: centerThenFirst },
        text: { proposePolicy: [CLIMB.v1, CLIMB.v2, CLIMB.v3, CLIMB.v3] },
      });
      const judge = jevJudge();
      const report = await runBenchmark({
        modelDecide: model.decide,
        reflection: model,
        judge: judge.model,
        rounds: 5,
        log: (line) => lines.push(line),
      });

      expect(report.arms.map((arm) => arm.label)).toEqual([
        "M: raw model",
        "J: Jev",
        "P0: ttt-policy-v0",
        "P1: ttt-policy-v1",
        "P2: ttt-policy-v2",
        "P3: ttt-policy-v3",
      ]);
      // Every move the model arms made was a closed choice over empty cells.
      expect(judge.calls.length).toBeGreaterThan(0);
      const decided = model.calls.filter((call) => call.kind === "decide");
      expect(decided.every((call) => boardOf(call.request).length === 9)).toBe(true);

      const [m, j, p0, , , p3] = report.arms;
      expect(m!.proof).toBeUndefined();
      expect(j!.objective).toBeUndefined();
      expect(p0!.proof).toBe("refuted");
      expect(p3!.proof).toBe("proven");
      expect(p3!.match.byOpponent.perfect.losses).toBe(0);
      expect(p3!.match.byOpponent.greedy.losses).toBe(0);
      expect(p3!.objective!).toBeGreaterThan(p0!.objective!);
      // Every arm plays the same match: 45 games.
      for (const arm of report.arms) expect(arm.match.games).toHaveLength(45);
      expect((await report.store.read("M/perfect/0")).length).toBeGreaterThan(2);

      const table = formatReport(report);
      console.log(table);
      expect(table.split("\n")[0]).toBe(
        "| arm | random W/D/L | greedy W/D/L | perfect W/D/L | proof | objective |",
      );
      for (const arm of report.arms) expect(table).toContain(`| ${arm.label} |`);
      expect(table).toContain("round 4: ttt-policy-v3");
      expect(lines).toHaveLength(report.arms.length);
    },
  );

  test("rounds: 0 still reports the P0 baseline arm", { timeout: 30_000 }, async () => {
    const model = createMockModelExecutors({ decisions: { player: centerThenFirst } });
    const report = await runBenchmark({
      modelDecide: model.decide,
      reflection: model,
      rounds: 0,
    });
    expect(report.improvement.rounds).toEqual([]);
    expect(report.arms.map((arm) => arm.label)).toEqual(["M: raw model", "P0: ttt-policy-v0"]);
    const [, p0] = report.arms;
    expect(p0!.proof).toBe("refuted");
    expect(p0!.match.games).toHaveLength(45);
    expect(Number.isFinite(p0!.objective)).toBe(true);
  });
});
