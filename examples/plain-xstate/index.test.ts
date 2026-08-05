import { describe, expect, test } from "vitest";
import { plainWriterMachine, runPlainXstateExample } from "./index.js";

describe("plain-xstate", () => {
  test("drives the plain machine to completion when the model approves", async () => {
    const result = await runPlainXstateExample(
      {
        generateText: async () => ({ output: "A crisp, concrete launch blurb." }),
        decide: async () => ({ event: { type: "APPROVE" } }),
      },
    );

    expect(result.decisions).toEqual(["APPROVE"]);
    expect(result.attempts).toBe(1);
    expect(result.draft).toBe("A crisp, concrete launch blurb.");
  });

  test("loops through REVISE and re-drafts, then approves", async () => {
    let judged = 0;
    const result = await runPlainXstateExample(
      {
        generateText: async () => ({ output: "draft" }),
        // REVISE the first two rounds, then APPROVE.
        decide: async () => {
          judged += 1;
          return { event: { type: judged <= 2 ? "REVISE" : "APPROVE" } };
        },
      },
    );

    // draft → judge(REVISE) → draft → judge(REVISE) → draft → judge(APPROVE)
    expect(result.decisions).toEqual(["REVISE", "REVISE", "APPROVE"]);
    expect(result.attempts).toBe(3);
  });

  test("the guard — not the model — bounds the revision loop", () => {
    // At the budget, REVISE is not takeable; only APPROVE remains legal.
    const spent = plainWriterMachine.resolveState({
      value: "judging",
      context: { topic: "x", maxRevisions: 2, attempts: 3, draft: "d" },
    });
    expect(spent.can({ type: "REVISE" })).toBe(false);
    expect(spent.can({ type: "APPROVE" })).toBe(true);

    // Within the budget, both are legal.
    const withinBudget = plainWriterMachine.resolveState({
      value: "judging",
      context: { topic: "x", maxRevisions: 2, attempts: 1, draft: "d" },
    });
    expect(withinBudget.can({ type: "REVISE" })).toBe(true);
    expect(withinBudget.can({ type: "APPROVE" })).toBe(true);
  });
});
