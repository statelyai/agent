/**
 * Keyless: every seam runs scripted, so the routing, the slicing, and the
 * scorers are testable with no key and no network.
 */
import { describe, expect, test } from "vitest";
import {
  clarifySeam,
  draftSeam,
  reviseSeam,
  runSeamCase,
  scoreAssessment,
  scoreDraft,
  scoreSeamEvents,
  scoreSeamStatePath,
  seams,
} from "./seams.js";

describe("seam evals", () => {
  test.each(
    seams.flatMap((seam) =>
      seam.rows.map((row) => [seam.id, row.metadata.case, row, seam.scorers] as const),
    ),
  )("%s / %s: every scorer is perfect on the scripted seam", async (_id, _case, row, scorers) => {
    const output = await runSeamCase(row.input, null);

    expect(output.status).toBe("done");
    for (const scorer of scorers) {
      expect(scorer(output, row.expected).score).toBe(1);
    }
  });

  test("the slice starts at the seam, not at the run", async () => {
    const row = clarifySeam[0]!;
    const output = await runSeamCase(row.input, null);

    // The whole run starts at `prompting`; the seam's slice starts where the
    // call was made and carries only the branch the seam chose.
    expect(output.statePath[0]).toBe("prompting");
    expect(output.seamStatePath).toContain("needsMoreInfo");
    expect(output.seamStatePath).not.toContain("prompting");
    // The event slice opens with the seam's own effect completion.
    expect(output.seamEvents[0]).toMatch(/^xstate\.done/);
    expect(output.seamEvents).toContain("MORE_INFO");
    expect(output.seamEvents).not.toContain("PROMPT_SUBMITTED");
  });

  test("a seam that misses the missing recipient loses path credit, not output credit", async () => {
    const row = clarifySeam[0]!;
    // Candidate under test: an evaluator that waves the vague prompt through.
    const output = await runSeamCase(row.input, async () => ({
      output: { satisfied: true, missing: [], questions: [] },
    }));

    expect(output.status).toBe("done");
    // It never asked, so it never reached `needsMoreInfo`.
    expect(output.seamStatePath).not.toContain("needsMoreInfo");
    expect(scoreSeamStatePath(output, row.expected).score).toBeLessThan(1);
    expect(scoreSeamEvents(output, row.expected).score).toBeLessThan(1);
    expect(scoreAssessment(output, row.expected).score).toBeLessThan(1);
    // The email still went out, which is why the seam is scored separately.
    expect(output.sentEmails).toHaveLength(1);
  });

  test("the state-path scorer reports where it diverged", async () => {
    const row = clarifySeam[0]!;
    const output = await runSeamCase(row.input, async () => ({
      output: { satisfied: true, missing: [], questions: [] },
    }));

    expect(scoreSeamStatePath(output, row.expected).metadata.firstMiss).toMatchObject({
      expected: "needsMoreInfo",
    });
  });

  test("only the seam call is routed to the candidate; the rest stay scripted", async () => {
    const row = draftSeam[1]!;
    const seen: string[] = [];
    const output = await runSeamCase(row.input, async (request) => {
      seen.push(request.model);
      return { output: { to: "team@example.com", subject: "Ship", body: "The deploy is faster." } };
    });

    // One clarification round plus one draft: three model calls, one candidate.
    expect(seen).toEqual(["emailDrafter"]);
    expect(scoreDraft(output, row.expected).score).toBe(1);
  });

  test("the revise seam scores the SECOND draft call", async () => {
    const row = reviseSeam[0]!;
    const seen: string[] = [];
    const output = await runSeamCase(row.input, async (request) => {
      seen.push(request.model);
      // A candidate that ignores the revision request.
      return { output: { to: "team@example.com", subject: "Deploy", body: "Unchanged." } };
    });

    expect(seen).toEqual(["emailDrafter"]);
    // The first draft was scripted; the seam's answer is the revision.
    expect((output.seamOutput as { body: string }).body).toBe("Unchanged.");
    // It dropped "Friday", so the draft scorer docks it.
    expect(scoreDraft(output, row.expected).score).toBeLessThan(1);
    // The machine still went where it should: seam scores are independent.
    expect(scoreSeamStatePath(output, row.expected).score).toBe(1);
  });
});
