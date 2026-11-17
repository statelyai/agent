import { describe, expect, test } from "vitest";
import { canReach } from "@statelyai/agent/testing";
import { APPROVAL_THRESHOLD, handleRefundRequest } from "./before.js";
import { SCENARIOS, checkRun, recordRun, runVerifyInPlaceExample } from "./index.js";
import { refundModel } from "./model.js";
import { handleRefundRequestRegressed } from "./regression.js";

type Snapshot = {
  matches: (state: string) => boolean;
  context: { amount: number; approved: boolean; order: { total: number } | null };
};

// The decisions the model may receive, for the proofs: a small, a large, and
// an over-total refund, a reply, and another round.
const proofOptions = {
  input: { orderId: "P-1" },
  outputs: {
    lookupOrder: [{ orderId: "P-1", total: 300 }],
    decide: [
      { type: "refund", amount: 50 },
      { type: "refund", amount: 250 },
      { type: "refund", amount: 400 },
      { type: "reply", message: "ok" },
      { type: "investigate" },
    ],
    issueRefund: [undefined],
  },
  maxDepth: 12,
};

describe("verify in place: the model's rules", () => {
  test("no refund over the threshold without an approval", async () => {
    const result = await canReach(
      refundModel,
      ((snapshot: Snapshot) =>
        snapshot.matches("refunding") &&
        snapshot.context.amount > APPROVAL_THRESHOLD &&
        !snapshot.context.approved) as never,
      proofOptions as never,
    );
    expect(result).toMatchObject({ reachable: false, complete: true });
  });

  test("the search does reach large refunds, through approval", async () => {
    // Not vacuous: the path the first proof guards exists.
    const result = await canReach(
      refundModel,
      ((snapshot: Snapshot) =>
        snapshot.matches("refunding") &&
        snapshot.context.amount > APPROVAL_THRESHOLD &&
        snapshot.context.approved) as never,
      proofOptions as never,
    );
    expect(result.reachable).toBe(true);
  });

  test("no refund over the order total", async () => {
    const result = await canReach(
      refundModel,
      ((snapshot: Snapshot) =>
        snapshot.matches("refunding") &&
        snapshot.context.amount > snapshot.context.order!.total) as never,
      proofOptions as never,
    );
    expect(result).toMatchObject({ reachable: false, complete: true });
  });
});

describe("verify in place: recorded runs of the unchanged code", () => {
  test("every recorded run conforms, and coverage names what no run reached", async () => {
    const { rows, unvisitedStates } = await runVerifyInPlaceExample();
    expect(rows.filter((row) => !row.conforms)).toEqual([]);
    expect(rows).toHaveLength(SCENARIOS.length);
    expect(unvisitedStates).toEqual([]);
  });
});

describe("verify in place: a seeded regression", () => {
  test("the repeat-customer shortcut is caught where the model waits for approval", async () => {
    const { rows } = await runVerifyInPlaceExample(handleRefundRequestRegressed);
    const deviating = rows.filter((row) => !row.conforms);
    expect(deviating.map((row) => row.id)).toEqual(["repeat customer, mid-size refund"]);
    // The model waits for a person; the code refunded without asking.
    expect(deviating[0]!.deviation).toMatchObject({
      reason: "extra-observations",
      expected: "idle, waiting for an event",
      observed: { kind: "refund", amount: 150 },
      state: "awaitingApproval",
    });
  });

  test("a refund to the wrong order is an input mismatch", async () => {
    const scenario = SCENARIOS[0]!;
    const recording = await recordRun(scenario, async (fx, request) => {
      await fx.lookupOrder(request.orderId);
      await fx.decide({ request: request.message, order: scenario.order, decisions: 0 });
      await fx.issueRefund({ orderId: "OTHER", amount: 40 });
    });
    const report = await checkRun(scenario, recording);
    expect(report.deviation).toMatchObject({
      reason: "input-mismatch",
      expected: "issueRefund",
      observed: { kind: "refund", orderId: "OTHER", amount: 40 },
      actorInput: { orderId: "A-1", amount: 40 },
    });
  });

  test("the other runs of the regressed code still conform", async () => {
    for (const scenario of SCENARIOS.filter((s) => !s.repeatCustomer)) {
      const report = await checkRun(
        scenario,
        await recordRun(scenario, handleRefundRequestRegressed),
      );
      expect(report.conforms, scenario.id).toBe(true);
    }
  });

  test("an approval for another amount is an input mismatch", async () => {
    const scenario = SCENARIOS[1]!; // a refund of 250, approved
    const recording = await recordRun(scenario, async (fx, request) => {
      const order = await fx.lookupOrder(request.orderId);
      const decision = await fx.decide({ request: request.message, order, decisions: 0 });
      const amount = decision.type === "refund" ? decision.amount : 0;
      await fx.requestApproval({ orderId: order.orderId, amount: amount / 10 });
      await fx.issueRefund({ orderId: order.orderId, amount });
      return "refunded";
    });
    const report = await checkRun(scenario, recording);
    expect(report.deviation).toMatchObject({
      reason: "input-mismatch",
      expected: "event approval",
      observed: { kind: "approval", amount: 25 },
      state: "awaitingApproval",
    });
  });

  test("a return value the model does not end with is an output mismatch", async () => {
    const scenario = SCENARIOS[0]!; // a small refund
    const recording = await recordRun(scenario, async (fx, request) => {
      await handleRefundRequest(fx, request);
      return "replied";
    });
    const report = await checkRun(scenario, recording);
    expect(report.deviation).toMatchObject({
      reason: "output-mismatch",
      observed: { kind: "returned", outcome: "replied" },
      state: "refunded",
    });
  });
});
