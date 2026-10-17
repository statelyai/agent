import type { AgentDecisionRequest } from "@statelyai/agent";
import { describe, expect, test } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import { createMockModelExecutors } from "../mock-model.js";
import { findOrderIds, runSplits } from "./contract.js";
import {
  createJudgeDeskArm,
  createModelDeskArm,
  createRawLoopArm,
  formatReport,
  runBenchmark,
} from "./benchmark.js";
import { objective } from "./improve.js";
import { loadPlaybook } from "./playbook.js";
import { eagerChoice, jevJudge } from "./test-doubles.js";

const v1 = loadPlaybook("v1");

const usage = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};

/**
 * A plausible sloppy model for the raw loop: refunds the mentioned amount on
 * its first step, without verifying or asking for approval; closes otherwise.
 */
function sloppyRawModel() {
  return new MockLanguageModelV3({
    doGenerate: async ({ prompt }) => {
      const text = JSON.stringify(prompt.filter((message) => message.role === "user"));
      const amount = /\$(\d+)/.exec(text);
      const [orderId = "ORD-0000"] = findOrderIds(text);
      const [toolName, input] = amount
        ? ["issueRefund", { orderId, amount: Number(amount[1]) }]
        : ["close", { reason: "nothing to refund" }];
      return {
        content: [
          { type: "tool-call", toolCallId: "call-1", toolName, input: JSON.stringify(input) },
        ],
        finishReason: { unified: "tool-calls", raw: "tool_calls" },
        usage,
        warnings: [],
      };
    },
  });
}

/** Criteria texts of every closed choice a mock judge was asked. */
const criteriaOf = (judge: ReturnType<typeof jevJudge>) =>
  judge.calls.flatMap((call) => {
    const next = call.questions["next"] as { criteria?: Record<string, string> } | undefined;
    return next?.criteria ? Object.values(next.criteria) : [];
  });

describe("benchmark arms", () => {
  test("A: the raw loop pays out against the rules", async () => {
    const { all } = await runSplits(createRawLoopArm({ model: sloppyRawModel() }));
    expect(all.violations).toBeGreaterThan(0);
    const rules = new Set(all.episodes.flatMap((e) => e.violations.map((v) => v.rule)));
    expect([...rules].sort()).toEqual([
      "double-refund",
      "unapproved-over-threshold",
      "unverified-identity",
    ]);
    expect(all.rejections).toBe(0);
    expect(all.modelCalls).toBe(all.episodes.length);
  });

  test("B: the desk with an eager model only ever takes legal steps", async () => {
    const model = createMockModelExecutors({ decisions: { "*": eagerChoice } });
    const { all } = await runSplits(createModelDeskArm(model.decide));
    expect(all.violations).toBe(0);
    expect(all.modelCalls).toBe(model.calls.length);
    // The model is offered only legal options.
    expect(
      (model.calls[0]!.request as AgentDecisionRequest).options?.map(({ event }) => event),
    ).not.toContainEqual({
      type: "ISSUE_REFUND",
      amount: 40,
    });
  });

  test("J vs J−: the same judge, with and without the machine-derived lookahead", async () => {
    const withLookahead = jevJudge();
    const without = jevJudge();
    const j = await runSplits(createJudgeDeskArm(withLookahead.model, { lookahead: true }));
    const jMinus = await runSplits(createJudgeDeskArm(without.model, { lookahead: false }));
    for (const { all } of [j, jMinus]) {
      expect(all.violations).toBe(0);
      expect(all.modelCalls).toBe(0);
      expect(all.judgeCalls).toBeGreaterThan(0);
    }
    // The only difference is what each option's criterion says.
    expect(criteriaOf(withLookahead).every((text) => text.includes("Then:"))).toBe(true);
    expect(criteriaOf(without).some((text) => text.includes("Then:"))).toBe(false);
    expect(criteriaOf(without)[0]).toBe(
      criteriaOf(withLookahead)[0]!.slice(0, criteriaOf(withLookahead)[0]!.indexOf(". Then:")),
    );
  });
});

describe("runBenchmark", () => {
  test("end to end with mocks: six arms, v0 -> v1 promoted", { timeout: 60_000 }, async () => {
    const lines: string[] = [];
    const text = createMockModelExecutors({
      text: { proposePlaybook: v1 },
      decisions: { "*": eagerChoice },
    });
    const report = await runBenchmark({
      textModel: sloppyRawModel(),
      judge: jevJudge().model,
      executors: text,
      log: (line) => lines.push(line),
    });

    expect(report.arms.map((arm) => arm.label)).toEqual([
      "A: raw tool loop",
      "B: desk + raw model",
      "J: desk + Jev",
      "J−: desk + Jev, no lookahead",
      "C0: desk + refund-playbook-v0",
      "C1: desk + refund-playbook-v1",
    ]);
    const [a, ...desk] = report.arms;
    expect(a!.all.violations).toBeGreaterThan(0);
    for (const arm of desk) expect(arm.all.violations, arm.label).toBe(0);

    const c1 = report.arms.at(-1)!;
    expect(c1.train.accuracy).toBe(1);
    expect(c1.heldOut.accuracy).toBe(1);
    const c0 = report.arms.at(-2)!;
    expect(objective(c1.all)).toBeGreaterThan(objective(c0.all));

    expect(report.improvements[0]!.promoted).toBe(true);
    // Round 2 proposes v1 again: no better, so the loop stops there.
    expect(report.improvements).toHaveLength(2);
    expect(report.improvements[1]!.promoted).toBe(false);

    // Every desk arm journaled its episodes: one thread per arm and scenario.
    expect((await report.store.read("B/small-clean")).length).toBeGreaterThan(2);
    expect((await report.store.read("J-/held-no-order-id")).length).toBeGreaterThan(2);

    const table = formatReport(report);
    console.log(table);
    for (const arm of report.arms) expect(table).toContain(arm.label);
    expect(table).toContain("| objective |");
    expect(table).toContain("round 1: promoted");
    expect(lines).toHaveLength(report.arms.length + report.improvements.length);
  });
});
