import { describe, expect, test } from "vitest";
import { canReach } from "@statelyai/agent/testing";
import { APPROVAL_THRESHOLD } from "./before.js";
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

  test("the other runs of the regressed code still conform", async () => {
    for (const scenario of SCENARIOS.filter((s) => !s.repeatCustomer)) {
      const report = await checkRun(
        scenario,
        await recordRun(scenario, handleRefundRequestRegressed),
      );
      expect(report.conforms, scenario.id).toBe(true);
    }
  });
});
