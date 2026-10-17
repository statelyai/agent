import { describe, expect, test } from "vitest";
import type { Experimental_DecisionModel } from "ai";
import { resolveDecision, type AgentExecutorDecisionRequest } from "../decision.js";
import { createDecisionModelDecide } from "./index.js";

type DoDecideModel = Extract<Experimental_DecisionModel, { doDecide: unknown }>;
type CallOptions = Parameters<DoDecideModel["doDecide"]>[0];

// Minimal doDecide double: answers `pick` (the next one per call, the last
// repeating) to every choice question, with `share` of the probability mass on it.
function judge(picks: string | string[], share: number) {
  const calls: CallOptions[] = [];
  const model: DoDecideModel = {
    specificationVersion: "v4",
    provider: "test",
    modelId: "test-judge",
    supportedQuestionTypes: ["choice"],
    doDecide: async (options) => {
      calls.push(options);
      const list = [picks].flat();
      const pick = list[Math.min(calls.length, list.length) - 1]!;
      const answers = Object.fromEntries(
        Object.entries(options.questions).map(([id, question]) => {
          const labels = Object.keys(question.criteria ?? {});
          const rest = labels.length > 1 ? (1 - share) / (labels.length - 1) : 0;
          return [
            id,
            {
              type: "choice" as const,
              choice: pick,
              probabilities: Object.fromEntries(
                labels.map((label) => [label, label === pick ? share : rest]),
              ),
            },
          ];
        }),
      );
      return { answers, warnings: [], usage: { inputTokens: 3, outputTokens: 1 } };
    },
  };
  return { model, calls };
}

const request: AgentExecutorDecisionRequest = {
  kind: "decision",
  id: "d1",
  name: "triage",
  model: "judge",
  prompt: "What should the desk do?",
  input: { ticket: "Charged twice" },
  events: [
    { type: "refund", toolName: "send_event_refund" },
    { type: "escalate", toolName: "send_event_escalate" },
  ],
  options: [
    { event: { type: "refund", amount: 20 }, description: "Refund $20" },
    { event: { type: "escalate" } },
  ],
  attempts: [],
};

describe("createDecisionModelDecide", () => {
  test("asks one choice question whose criteria are the option descriptions", async () => {
    const { model, calls } = judge("refund:20", 0.9);
    const result = await createDecisionModelDecide(model)(request);

    expect(calls).toHaveLength(1);
    const questions = Object.values(calls[0]!.questions);
    expect(questions).toHaveLength(1);
    expect(questions[0]).toMatchObject({
      type: "choice",
      instructions: "What should the desk do?",
      criteria: { "refund:20": "Refund $20", escalate: '{"type":"escalate"}' },
    });
    expect(calls[0]!.state).toEqual([{ type: "json", value: { ticket: "Charged twice" } }]);
    expect(result.event).toEqual({ type: "refund", amount: 20 });
    expect(result.confidence).toBe(0.9);
  });

  test("throws a low-confidence error below minConfidence", async () => {
    const { model } = judge("escalate", 0.55);
    await expect(createDecisionModelDecide(model, { minConfidence: 0.6 })(request)).rejects.toThrow(
      /low confidence/,
    );
  });

  test("a label that is not an option is retried, naming the valid ids", async () => {
    const { model, calls } = judge(["refund:99", "escalate"], 0.9);
    const decide = createDecisionModelDecide(model);
    const seen: AgentExecutorDecisionRequest[] = [];
    const event = await resolveDecision(request, {
      decide: (attempt, info) => (seen.push(attempt), decide(attempt, info)),
    });

    expect(event).toEqual({ type: "escalate" });
    expect(calls).toHaveLength(2);
    expect(seen[1]!.attempts).toEqual([
      expect.objectContaining({
        failure: "unknown-event",
        reason: expect.stringContaining(
          `option "refund:99" was not offered (valid ids: refund:20, escalate)`,
        ),
      }),
    ]);
  });

  test("throws when the request has no options", async () => {
    const { model, calls } = judge("escalate", 0.9);
    await expect(
      createDecisionModelDecide(model)({ ...request, options: undefined }),
    ).rejects.toThrow(/has no options/);
    expect(calls).toHaveLength(0);
  });
});
