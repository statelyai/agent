/**
 * No API key, no Braintrust service: a mock model answers each row's calls.
 * The scorers are plain functions over a `runAgent` result, so they are
 * testable on their own — which is the point of the example.
 */
import type { AgentRequestExecutors } from "@statelyai/agent";
import { describe, expect, test } from "vitest";
import { createMockModelExecutors } from "../mock-model.js";
import {
  dataset,
  runDrafterCase,
  scoreEventTrajectory,
  scoreOutputStructure,
  scoreStatePath,
  scoreTokenBudget,
} from "./index.js";

/** Canned model answers for one row. */
interface RowScript {
  /** One assessment per `evaluatePrompt` call. */
  assessments: { satisfied: boolean; missing: string[]; questions: string[] }[];
  /** The draft the model returns. */
  draft: { to: string; subject: string; body: string };
  /** Tokens each call reports, so the budget scorer has real numbers. */
  tokensPerCall: number;
}

const DRAFT = {
  to: "team@example.com",
  subject: "Deploy pipeline is twice as fast",
  body: "Hi team, the deploy pipeline now runs in half the time. Details in the thread.",
};
const NEEDS_RECIPIENT = {
  satisfied: false,
  missing: ["recipient"],
  questions: ["Who should receive it?"],
};
const COMPLETE = { satisfied: true, missing: [], questions: [] };

const scripts: Record<string, RowScript> = {
  "asks-for-missing-recipient": {
    assessments: [NEEDS_RECIPIENT, COMPLETE],
    draft: DRAFT,
    tokensPerCall: 150,
  },
  "complete-prompt-drafts-directly": { assessments: [COMPLETE], draft: DRAFT, tokensPerCall: 150 },
  "user-declines-to-add-details": {
    assessments: [NEEDS_RECIPIENT],
    draft: DRAFT,
    tokensPerCall: 150,
  },
};

/**
 * Mock-model executors for one row. The mock reports zero usage, so each
 * call's result is stamped with the row's token count on its way back to
 * `runAgent` — the same `usage` field a real adapter fills.
 */
function executorsFor(script: RowScript): Partial<AgentRequestExecutors> {
  const mock = createMockModelExecutors({
    text: { evaluatePrompt: script.assessments, draftEmail: script.draft },
  });
  const usage = {
    inputTokens: script.tokensPerCall,
    outputTokens: 0,
    totalTokens: script.tokensPerCall,
  };
  return {
    ...mock,
    generateText: async (request, info) => ({
      ...(await mock.generateText(request, info)),
      usage,
    }),
  };
}

function scriptFor(row: { metadata: { case: string } }): RowScript {
  return scripts[row.metadata.case]!;
}

describe("braintrust-evals", () => {
  test.each(dataset.map((row) => [row.metadata.case, row] as const))(
    "%s: every scorer is perfect on the mock-model run",
    async (_name, row) => {
      const output = await runDrafterCase(row.input, executorsFor(scriptFor(row)));

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

  test("the XState transition events form an ordered trajectory", async () => {
    const row = dataset[0]!;
    const output = await runDrafterCase(row.input, executorsFor(scriptFor(row)));

    expect(output.eventTrajectory[0]).toBe("@xstate.init");
    expect(output.eventTrajectory).toContain("PROMPT_SUBMITTED");
    expect(output.eventTrajectory).toContain("MORE_INFO");
    expect(output.eventTrajectory).toContain("END");
    // Invoked actor completions are visible as ordinary XState events.
    expect(output.eventTrajectory.filter((type) => type.startsWith("xstate.done"))).toHaveLength(4);
  });

  test("usage sums across resume legs, so the budget scorer sees the whole run", async () => {
    const row = dataset[0]!;
    const output = await runDrafterCase(row.input, executorsFor(scriptFor(row)));

    // Two assessments plus one draft, at the row's 150 tokens each.
    expect(output.modelCalls).toBe(3);
    expect(output.totalTokens).toBe(450);
    expect(scoreTokenBudget(output, row.expected).score).toBe(1);
  });

  test("scorers discriminate: an evaluator that never asks for the missing recipient loses path credit", async () => {
    const row = dataset[0]!;
    // Same row, but the model claims the vague prompt is already complete.
    const overconfident: RowScript = { ...scriptFor(row), assessments: [COMPLETE] };

    const output = await runDrafterCase(row.input, executorsFor(overconfident));

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
    const expensive: RowScript = { ...scriptFor(row), tokensPerCall: 600 };

    const output = await runDrafterCase(row.input, executorsFor(expensive));

    expect(output.totalTokens).toBe(1800);
    // 1800 against a 900 budget: exactly twice the budget scores 0.
    expect(scoreTokenBudget(output, row.expected).score).toBe(0);
  });
});
