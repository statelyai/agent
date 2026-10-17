import { describe, expect, test } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import type { AgentDecisionRequest } from "@statelyai/agent";
import { createMockJudge } from "../mock-judge.js";
import { createMockModelExecutors, type MockTextEntry } from "../mock-model.js";
import { findOrderIds, runBatch, type BatchMetrics } from "./contract.js";
import {
  createModelDeskArm,
  createPlaybookArm,
  createRawLoopArm,
  formatReport,
  runBenchmark,
} from "./benchmark.js";
import { createPlaybookDecide, loadPlaybook } from "./playbook.js";

const v0 = loadPlaybook("v0");
const v1 = loadPlaybook("v1");

const usage = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};

/** The user messages of an AI SDK prompt (the system prompt quotes the threshold). */
function userText(prompt: { role: string }[]): string {
  return JSON.stringify(prompt.filter((message) => message.role === "user"));
}

/**
 * A plausible sloppy model for the raw loop: refunds the mentioned amount on
 * its first step, without verifying or asking for approval; closes otherwise.
 */
function sloppyRawModel() {
  return new MockLanguageModelV3({
    doGenerate: async ({ prompt }) => {
      const text = userText(prompt);
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

/**
 * The same sloppiness as a desk decider: propose ISSUE_REFUND of the
 * mentioned amount, CLOSE when there is none, and ESCALATE once anything was
 * rejected (a retry in `attempts`, or a rejection the prompt reports).
 */
function sloppyDecision(request: AgentDecisionRequest) {
  const prompt = request.prompt ?? "";
  const rejected =
    request.attempts.length > 0 || /Reject(?:ed|ions) so far: *(?!\(none\))[A-Z]/.test(prompt);
  if (rejected) return { type: "ESCALATE", reason: "the desk refused" };
  const amount = /\$(\d+)/.exec(prompt);
  return amount
    ? { type: "ISSUE_REFUND", amount: Number(amount[1]) }
    : { type: "CLOSE", reason: "nothing to refund" };
}

/** A refund request unless it asks about the shipping address. */
const judge = () =>
  createMockJudge({
    isRefundRequest: (state) => !/shipping address/i.test((state as { ticket: string }).ticket),
  });

function mockExecutors(proposals: MockTextEntry | MockTextEntry[] = v1) {
  return createMockModelExecutors({
    decisions: { "*": sloppyDecision },
    text: { proposePlaybook: proposals },
  });
}

const numbers = (m: BatchMetrics) => ({
  accuracy: m.accuracy,
  violations: m.violations,
  modelCalls: m.modelCalls,
  judgeCalls: m.judgeCalls,
  rejections: m.rejections,
});
const cost = (m: BatchMetrics) => m.modelCalls + m.judgeCalls + m.rejections;

describe("benchmark arms", () => {
  test("A: the raw loop pays out against the rules", async () => {
    const batch = await runBatch(createRawLoopArm({ model: sloppyRawModel() }));
    console.log("A", numbers(batch));
    expect(batch.violations).toBeGreaterThan(0);
    const rules = new Set(batch.episodes.flatMap((e) => e.violations.map((v) => v.rule)));
    expect([...rules].sort()).toEqual([
      "double-refund",
      "unapproved-over-threshold",
      "unverified-identity",
    ]);
    expect(batch.rejections).toBe(0);
    expect(batch.judgeCalls).toBe(0);
    expect(batch.modelCalls).toBe(batch.episodes.length);
  });

  test("B: the desk with the same sloppy model rejects instead of paying", async () => {
    const model = mockExecutors();
    const batch = await runBatch(createModelDeskArm(model.decide));
    console.log("B", numbers(batch));
    expect(batch.violations).toBe(0);
    expect(batch.rejections).toBeGreaterThan(0);
    expect(batch.modelCalls).toBe(model.calls.filter((c) => c.kind === "decide").length);
  });

  test("C0 vs C1: playbook v1 is right and cheaper than v0", async () => {
    const model = mockExecutors();
    const c0 = await runBatch(
      createPlaybookArm(createPlaybookDecide(v0, { executors: model, judge: judge().model })),
    );
    const c1 = await runBatch(
      createPlaybookArm(createPlaybookDecide(v1, { executors: model, judge: judge().model })),
    );
    console.log("C0", numbers(c0));
    console.log("C1", numbers(c1));
    expect(c0.violations).toBe(0);
    expect(c1.violations).toBe(0);
    expect(c1.accuracy).toBeGreaterThanOrEqual(c0.accuracy);
    expect(cost(c1)).toBeLessThan(cost(c0));
    // v0 spends model calls, v1 spends judge calls instead.
    expect(c0.modelCalls).toBeGreaterThan(0);
    expect(c1.modelCalls).toBe(0);
    expect(c1.judgeCalls).toBeGreaterThan(0);
  });
});

describe("runBenchmark", () => {
  test("end to end with mocks: v0 -> v1 promoted, four arms in the table", async () => {
    const lines: string[] = [];
    const report = await runBenchmark({
      textModel: sloppyRawModel(),
      judge: judge().model,
      executors: mockExecutors(v1),
      log: (line) => lines.push(line),
    });

    expect(report.arms.map((arm) => arm.label)).toEqual([
      "A: raw tool loop",
      "B: desk + raw model",
      "C0: desk + refund-playbook-v0",
      "C1: desk + refund-playbook-v1",
    ]);
    expect(report.improvements[0]!.promoted).toBe(true);
    // Round 2 proposes v1 again: no cheaper, so the loop stops there.
    expect(report.improvements).toHaveLength(2);
    expect(report.improvements[1]!.promoted).toBe(false);

    const [a, b, c0, ck] = report.arms as [BatchMetrics, BatchMetrics, BatchMetrics, BatchMetrics];
    expect(a.violations).toBeGreaterThan(0);
    expect(b.violations).toBe(0);
    expect(c0.violations).toBe(0);

    const v1Alone = await runBatch(
      createPlaybookArm(
        createPlaybookDecide(v1, { executors: mockExecutors(), judge: judge().model }),
      ),
    );
    expect(numbers(ck)).toEqual(numbers(v1Alone));

    const table = formatReport(report);
    console.log(table);
    for (const arm of report.arms) expect(table).toContain(arm.label);
    expect(table).toContain("round 1: promoted");
    expect(lines).toHaveLength(report.arms.length + report.improvements.length);
  });
});
