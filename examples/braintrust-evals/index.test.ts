/**
 * Keyless: scripted executors, no env reads, no Braintrust service. The scorers
 * are plain functions over a `runAgent` result, so they are testable on their
 * own — which is the point of the example.
 */
import { describe, expect, test } from "vitest";
import {
  dataset,
  runDrafterCase,
  scoreEventTrajectory,
  scoreOutputStructure,
  scoreStatePath,
  scoreTokenBudget,
  scriptedExecutorsFor,
} from "./index.js";
import type { DrafterCase } from "./index.js";

describe("braintrust-evals", () => {
  test.each(dataset.map((row) => [row.metadata.case, row] as const))(
    "%s: every scorer is perfect on the scripted run",
    async (_name, row) => {
      const output = await runDrafterCase(row.input, scriptedExecutorsFor(row.input));

      expect(output.status).toBe("done");
      for (const scorer of [
        scoreOutputStructure,
        scoreStatePath,
        scoreEventTrajectory,
        scoreTokenBudget,
      ]) {
        expect(scorer(output, row.expected).score).toBe(1);
      }
    },
  );

  test("the run's event log is the durable trajectory: JSON-safe, ordered, one entry per external input", async () => {
    const row = dataset[0]!;
    const output = await runDrafterCase(row.input, scriptedExecutorsFor(row.input));

    // The log opens with `@agent.init` and carries the human's events verbatim.
    expect(output.eventTrajectory[0]).toBe("@agent.init");
    expect(output.eventTrajectory).toContain("PROMPT_SUBMITTED");
    expect(output.eventTrajectory).toContain("MORE_INFO");
    expect(output.eventTrajectory).toContain("END");
    // Effect completions are journaled too — that is what makes it replayable.
    expect(output.eventTrajectory.filter((type) => type.startsWith("xstate.done"))).toHaveLength(4);
  });

  test("usage sums across resume legs, so the budget scorer sees the whole run", async () => {
    const row = dataset[0]!;
    const output = await runDrafterCase(row.input, scriptedExecutorsFor(row.input));

    // Two assessments plus one draft, at the row's scripted 150 tokens each.
    expect(output.modelCalls).toBe(3);
    expect(output.totalTokens).toBe(450);
    expect(scoreTokenBudget(output, row.expected).score).toBe(1);
  });

  test("scorers discriminate: an evaluator that never asks for the missing recipient loses path credit", async () => {
    const row = dataset[0]!;
    // Same row, but the model claims the vague prompt is already complete.
    const overconfident: DrafterCase = {
      ...row.input,
      script: {
        ...row.input.script,
        assessments: [{ satisfied: true, missing: [], questions: [] }],
      },
    };

    const output = await runDrafterCase(overconfident, scriptedExecutorsFor(overconfident));

    expect(output.status).toBe("done");
    // It never visited `needsMoreInfo`, so the expected path is only partly covered.
    expect(output.statePath).not.toContain("needsMoreInfo");
    expect(scoreStatePath(output, row.expected).score).toBeLessThan(1);
    expect(scoreEventTrajectory(output, row.expected).score).toBeLessThan(1);
    // The output still looks fine — which is exactly why trajectory is scored
    // separately from output.
    expect(scoreOutputStructure(output, row.expected).score).toBe(1);
  });

  test("the budget scorer degrades past the budget", async () => {
    const row = dataset[0]!;
    const expensive: DrafterCase = {
      ...row.input,
      script: { ...row.input.script, tokensPerCall: 600 },
    };

    const output = await runDrafterCase(expensive, scriptedExecutorsFor(expensive));

    expect(output.totalTokens).toBe(1800);
    // 1800 against a 900 budget: exactly twice the budget scores 0.
    expect(scoreTokenBudget(output, row.expected).score).toBe(0);
  });
});
