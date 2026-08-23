/**
 * Keyless: both candidates are scripted, so the addressing, the routing, and
 * the scorers are testable with no key and no network.
 */
import { describe, expect, test } from "vitest";
import {
  BAD_DRAFT,
  GOOD_DRAFT,
  renderTable,
  runCandidate,
  scoreCoverage,
  scoreLength,
  scoreTone,
  scriptedCandidates,
} from "./index.js";

const candidateFor = (label: string) =>
  scriptedCandidates().find((c) => c.label === label)!.candidate;

describe("seam scoring", () => {
  test("the seam is the first draftEmail call, and only it reaches the candidate", async () => {
    const run = await runCandidate("good", candidateFor("good"));

    expect(run.status).toBe("done");
    // Exactly one model call is the candidate's, and it is the drafter's —
    // addressed by its `actors:` key, which the unnamed request takes as `name`.
    expect(run.candidateCalls).toEqual(["draftEmail"]);
    // The evaluator ran first, from the script.
    expect(run.callsBeforeSeam).toBe(1);
    expect(run.scriptedCalls[0]).toBe("evaluatePrompt");
    // The seam's own answer is the candidate's draft, not a scripted one.
    expect(run.draft).toEqual(GOOD_DRAFT);
    // The slice starts at the seam: no `prompting`/`evaluating` before it.
    expect(run.statesAfterSeam[0]).toBe("reviewing");
    expect(run.statesAfterSeam).not.toContain("prompting");
  });

  test("every other request is served from the script", async () => {
    const good = await runCandidate("good", candidateFor("good"));
    const bad = await runCandidate("bad", candidateFor("bad"));

    // The `calls` ledger is the receipt. The candidate replaces the seam's
    // slot, so the good run scripts the evaluator and nothing else.
    expect(good.scriptedCalls).toEqual(["evaluatePrompt"]);
    // The bad draft was sent back, so the revision draft came from the script
    // too — one candidate call either way.
    expect(bad.scriptedCalls).toEqual(["evaluatePrompt", "draftEmail"]);
    expect(bad.candidateCalls).toEqual(["draftEmail"]);
    // Scripted plain values report no usage: the seam's cost stays undefined.
    expect(good.seamTokens).toBeUndefined();
  });

  test("the good candidate outscores the bad one on every scorer", async () => {
    const good = await runCandidate("good", candidateFor("good"));
    const bad = await runCandidate("bad", candidateFor("bad"));

    expect(good.total).toBe(1);
    expect(bad.total).toBeLessThan(good.total);
    for (const [index, score] of good.scores.entries()) {
      expect(score.score).toBeGreaterThan(bad.scores[index]!.score);
    }
  });

  test("the branch after the seam is a real consequence of it", async () => {
    const good = await runCandidate("good", candidateFor("good"));
    const bad = await runCandidate("bad", candidateFor("bad"));

    // The reviewer accepted the good draft and sent it.
    expect(good.statesAfterSeam).toEqual(["reviewing", "sending", "sent", "done"]);
    // The bad draft cost a revision round the good one never needed.
    expect(bad.statesAfterSeam).toContain("drafting");
    expect(bad.statesAfterSeam.length).toBeGreaterThan(good.statesAfterSeam.length);
  });

  test("the scorers grade the drafts, not the run", () => {
    expect(scoreLength(GOOD_DRAFT).score).toBe(1);
    expect(scoreLength(BAD_DRAFT).score).toBe(0);
    expect(scoreCoverage(GOOD_DRAFT).score).toBe(1);
    expect(scoreCoverage(BAD_DRAFT).note).toContain("recipient");
    expect(scoreTone(GOOD_DRAFT).score).toBe(1);
    expect(scoreTone(BAD_DRAFT).score).toBe(0);
    // Whole-word matching: "Ship it" is not a greeting.
    expect(scoreTone({ ...BAD_DRAFT, body: "Ship it." }).note).toContain("cold");
  });

  test("the table carries one row per candidate", async () => {
    const runs = [
      await runCandidate("good", candidateFor("good")),
      await runCandidate("bad", candidateFor("bad")),
    ];
    const table = renderTable(runs);

    expect(table.split("\n")).toHaveLength(4);
    expect(table).toContain("coverage");
    expect(table).toMatch(/good\s+1\.00/);
  });
});
