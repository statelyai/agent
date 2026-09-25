/**
 * No API key: every seam runs scripted, and a scripted Jev client answers the
 * prompt check, so the routing, the slicing, and the scorers are testable with
 * no key and no network.
 */
import { describe, expect, test } from "vitest";
import { createMockJevClient } from "../mock-jev.js";
import {
  clarifySeam,
  draftSeam,
  reviseSeam,
  runSeamCase,
  scoreDraft,
  scoreFollowUps,
  scoreSeamEvents,
  scoreSeamStatePath,
  seams,
  type SeamRow,
} from "./seams.js";

/**
 * The Jev prompt check per row: a row that details its request after the
 * questions is complete on the second look; one that declines stays vague.
 */
function jevFor(row: SeamRow) {
  const { prompt, details } = row.input;
  if (prompt.includes("@")) return createMockJevClient({ "*": true }).client;
  if (details !== null) {
    return createMockJevClient({ satisfied: [false, true], recipient: [false, true], "*": true })
      .client;
  }
  return createMockJevClient({ "*": false }).client;
}

describe("seam evals", () => {
  test.each(
    seams.flatMap((seam) =>
      seam.rows.map((row) => [seam.id, row.metadata.case, row, seam.scorers] as const),
    ),
  )("%s / %s: every scorer is perfect on the scripted seam", async (_id, _case, row, scorers) => {
    const output = await runSeamCase(row.input, null, jevFor(row));

    expect(output.status).toBe("done");
    for (const scorer of scorers) {
      expect(scorer(output, row.expected).score).toBe(1);
    }
  });

  test("the slice starts at the seam, not at the run", async () => {
    const row = clarifySeam[0]!;
    const output = await runSeamCase(row.input, null, jevFor(row));

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

  test("a seam that asks nothing loses question credit, not path credit", async () => {
    const row = clarifySeam[0]!;
    // Candidate under test: a follow-up writer that returns no questions.
    const output = await runSeamCase(
      row.input,
      async () => ({ result: { questions: [] } }),
      jevFor(row),
    );

    expect(output.status).toBe("done");
    // The judgment already chose to ask, so the branch is unchanged ...
    expect(output.seamStatePath).toContain("needsMoreInfo");
    expect(scoreSeamStatePath(output, row.expected).score).toBe(1);
    expect(scoreSeamEvents(output, row.expected).score).toBe(1);
    // ... and only the seam's own answer is docked.
    expect(scoreFollowUps(output, row.expected).score).toBeLessThan(1);
    expect(output.sentEmails).toHaveLength(1);
  });

  test("a judgment that waves the vague prompt through never reaches the seam, and the path scorer says where it diverged", async () => {
    const row = clarifySeam[0]!;
    const output = await runSeamCase(row.input, null, createMockJevClient({ "*": true }).client);

    expect(output.status).toBe("done");
    expect(output.seamOutput).toBeUndefined();
    expect(scoreSeamStatePath(output, row.expected).metadata.firstMiss).toMatchObject({
      expected: "needsMoreInfo",
    });
    // The email still went out, which is why the path is scored separately.
    expect(output.sentEmails).toHaveLength(1);
  });

  test("only the seam call is routed to the candidate; the rest stay scripted", async () => {
    const row = draftSeam[1]!;
    const seen: string[] = [];
    const output = await runSeamCase(
      row.input,
      async (request) => {
        seen.push(request.model);
        return {
          result: { to: "team@example.com", subject: "Ship", body: "The deploy is faster." },
        };
      },
      jevFor(row),
    );

    // One follow-up request plus one draft: two text calls, one candidate.
    expect(seen).toEqual(["emailDrafter"]);
    expect(scoreDraft(output, row.expected).score).toBe(1);
  });

  test("the revise seam scores the SECOND draft call", async () => {
    const row = reviseSeam[0]!;
    const seen: string[] = [];
    const output = await runSeamCase(
      row.input,
      async (request) => {
        seen.push(request.model);
        // A candidate that ignores the revision request.
        return { result: { to: "team@example.com", subject: "Deploy", body: "Unchanged." } };
      },
      jevFor(row),
    );

    expect(seen).toEqual(["emailDrafter"]);
    // The first draft was scripted; the seam's answer is the revision.
    expect((output.seamOutput as { body: string }).body).toBe("Unchanged.");
    // It dropped "Friday", so the draft scorer docks it.
    expect(scoreDraft(output, row.expected).score).toBeLessThan(1);
    // The machine still went where it should: seam scores are independent.
    expect(scoreSeamStatePath(output, row.expected).score).toBe(1);
  });
});
