import { describe, expect, test } from "vitest";
import { createMockJudge, type MockJudgeModel } from "../mock-judge.js";
import {
  MAX_CONCURRENCY,
  runRankCandidatesExample,
  type Candidate,
  type RankCandidatesInput,
} from "./index.js";

const BRIEF = "Talks for engineers who run agent workflows in production.";

const c = (id: string, bucket: string): Candidate => ({
  id,
  bucket,
  title: `Talk ${id}`,
  summary: `Summary of ${id}.`,
});

type FitState = { candidate: Candidate };
type PairState = { keep: Candidate; other: Candidate };

/** Scores by candidate id; `same` is true (0.95) for the listed id pairs, else `fallback`. */
function judgeFor(
  scores: Record<string, number>,
  samePairs: [string, string, number?][] = [],
  fallback = 0.05,
) {
  return createMockJudge({
    fit: (state) => scores[(state as FitState).candidate.id]!,
    same: (state) => {
      const { keep, other } = state as PairState;
      const hit = samePairs.find(
        ([a, b]) => (a === keep.id && b === other.id) || (a === other.id && b === keep.id),
      );
      return hit ? (hit[2] ?? 0.95) : fallback;
    },
  });
}

describe("rank-candidates", () => {
  test("ranks best first and cuts every other candidate with its reason", async () => {
    // Input order differs from score order, so the sort (and the tie rule) is exercised.
    const input: RankCandidatesInput = {
      brief: BRIEF,
      candidates: [
        c("m1", "community"),
        c("c1", "cost"),
        c("r1", "reliability"),
        c("r2", "reliability"),
        c("r3", "reliability"),
        c("o2", "observability"),
        c("r4", "reliability"),
        c("o1", "observability"),
        c("c2", "cost"),
        c("m2", "community"),
      ],
      top: 4,
      consider: 7,
      perBucket: 2,
      minScore: 2,
    };
    const judge = judgeFor(
      { m1: 1, c1: 2, r1: 3, r2: 3, r3: 3, o2: 2, r4: 3, o1: 3, c2: 2, m2: 0 },
      [["r1", "r3"]],
    );

    const result = await runRankCandidatesExample({ input, judge: judge.model });

    expect(result.finalState).toBe("done");
    expect(result.progress).toEqual(["scoring", "deduping", "done"]);
    expect(result.ranked.map((r) => [r.id, r.score])).toEqual([
      ["r1", 3],
      ["r2", 3],
      ["o1", 3],
      ["c1", 2],
    ]);
    expect(result.cut).toEqual([
      { id: "m1", reason: "below the minimum score" },
      { id: "m2", reason: "below the minimum score" },
      { id: "c2", reason: "outside the best 7 considered" },
      { id: "r3", reason: "duplicate of r1" },
      { id: "r4", reason: "bucket reliability is full" },
      { id: "o2", reason: "beyond the top 4" },
    ]);
    // Every candidate accounted for exactly once.
    expect([...result.ranked, ...result.cut].map((x) => x.id).sort()).toEqual(
      input.candidates.map((x) => x.id).sort(),
    );
    // Ten fit calls, then 7 × 6 / 2 pair calls, one question each.
    const fitCalls = judge.calls.filter((call) => "fit" in call.questions);
    const pairCalls = judge.calls.filter((call) => "same" in call.questions);
    expect(fitCalls).toHaveLength(10);
    expect(pairCalls).toHaveLength(21);
    expect(result.summary.split("\n")[0]).toBe("Ranked 4 of 10 candidates.");
  });

  test("a duplicate is cut only when its better twin was chosen", async () => {
    const input: RankCandidatesInput = {
      brief: BRIEF,
      candidates: [
        c("x", "reliability"),
        c("y", "reliability"),
        c("z", "observability"),
        c("w", "cost"),
      ],
      top: 5,
      perBucket: 1,
    };
    // y is cut for a full bucket, so z (its twin) stays; z ~ w at 0.7 is under the threshold.
    const judge = judgeFor({ x: 3, y: 3, z: 2, w: 2 }, [
      ["y", "z"],
      ["z", "w", 0.7],
    ]);

    const result = await runRankCandidatesExample({ input, judge: judge.model });

    expect(result.ranked.map((r) => r.id)).toEqual(["x", "z", "w"]);
    expect(result.cut).toEqual([{ id: "y", reason: "bucket reliability is full" }]);
  });

  test("a single considered candidate skips deduping", async () => {
    const judge = judgeFor({ a: 3, b: 0 });
    const result = await runRankCandidatesExample({
      input: { brief: BRIEF, candidates: [c("a", "x"), c("b", "x")] },
      judge: judge.model,
    });
    expect(result.progress).toEqual(["scoring", "done"]);
    expect(result.ranked.map((r) => r.id)).toEqual(["a"]);
    expect(judge.calls.every((call) => "fit" in call.questions)).toBe(true);
  });

  test("a judgment error lands in failed", async () => {
    const judge = createMockJudge({
      fit: () => {
        throw new Error("judge offline");
      },
    });
    const result = await runRankCandidatesExample({
      input: { brief: BRIEF, candidates: [c("a", "x")] },
      judge: judge.model,
    });
    expect(result.finalState).toBe("failed");
    expect(result.ranked).toEqual([]);
    expect(result.summary).toMatch(/^Ranking failed: scoring failed: .*judge offline/);
  });

  test(`keeps at most ${MAX_CONCURRENCY} judgments in flight`, async () => {
    const candidates = Array.from({ length: 12 }, (_, i) => c(`k${i}`, `b${i % 3}`));
    const base = judgeFor(Object.fromEntries(candidates.map((x) => [x.id, 0])));
    let inFlight = 0;
    let peak = 0;
    const model: MockJudgeModel = {
      ...base.model,
      doDecide: async (options) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        try {
          return await base.model.doDecide(options);
        } finally {
          inFlight--;
        }
      },
    };

    const result = await runRankCandidatesExample({
      input: { brief: BRIEF, candidates },
      judge: model,
    });

    expect(result.finalState).toBe("done");
    expect(base.calls).toHaveLength(12);
    expect(peak).toBe(MAX_CONCURRENCY);
  });
});
