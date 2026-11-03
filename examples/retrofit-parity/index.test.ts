import { expect, test } from "vitest";
import type { ParityResult } from "@statelyai/agent/testing";
import { canReach } from "@statelyai/agent/testing";
import {
  compareLoopAndMachine,
  recordLoop,
  refundLoopMachine,
  replayMachine,
  SCENARIOS,
  type Scenario,
} from "./index.js";

test.each(SCENARIOS)("the machine replays the recorded loop: $id", async (scenario) => {
  // The golden run: the loop's model calls, tool calls, and result.
  const recording = await recordLoop(scenario);
  expect(recording.effects.map((effect) => effect.kind)).toContain("tool");

  const report = await replayMachine(scenario, recording);

  expect(report.divergences).toEqual([]);
  expect(report.equivalent).toBe(true);
});

// Differences a person accepted, each with the exact difference asserted.
const REVIEWED: Record<string, (row: ParityResult<Scenario>) => void> = {
  // Accepted: refunds at or under APPROVAL_THRESHOLD no longer wait for a person.
  "small-refund": (row) => {
    expect(row.reason).toBe("effects differ");
    expect(row.candidate.outcome).toBe(row.baseline.outcome);
    expect(row.candidate.effects).toEqual({
      refunds: [{ orderId: "A-100", amount: 20 }],
      approvals: [],
    });
    expect(row.baseline.effects).toEqual({
      refunds: [{ orderId: "A-100", amount: 20 }],
      approvals: [{ orderId: "A-100", amount: 20 }],
    });
  },
};

test("parity with the loop: every regression is reviewed", async () => {
  const report = await compareLoopAndMachine();

  const unreviewed = report.scenarios.filter(
    (row) => row.label === "regression" && !REVIEWED[row.id],
  );
  expect(unreviewed).toEqual([]);
  for (const row of report.scenarios.filter((row) => REVIEWED[row.id])) REVIEWED[row.id]!(row);
  expect(report.counts).toEqual({ same: 3, intended: 0, regression: 1 });
});

test("no path reaches the refund tool with a refund above the order total", async () => {
  // The loop kept this rule in its prompt; the machine checks it in a choice state.
  const order = { orderId: "A-100", total: 20 };
  // A text request's output is its `result`: one per refund amount around the boundary.
  const assist = (amount: number) => ({
    text: "",
    calledTools: true,
    messages: [],
    lookups: [order],
    refund: { orderId: "A-100", amount },
  });
  const result = await canReach(refundLoopMachine, "refundOverTotal", {
    input: { ticket: "Refund A-100" },
    outputs: {
      assist: [assist(0), assist(20), assist(21), assist(500)],
      issueRefund: [{ refundId: "rf_A-100" }],
    },
  });

  expect(result.reachable).toBe(false);
  expect(result.complete).toBe(true);
});

test("the sentinel search is not vacuous: refunds still happen", async () => {
  const result = await canReach(refundLoopMachine, "refunded", {
    input: { ticket: "Refund A-100" },
    outputs: {
      assist: [
        {
          text: "",
          calledTools: true,
          messages: [],
          lookups: [{ orderId: "A-100", total: 20 }],
          refund: { orderId: "A-100", amount: 20 },
        },
      ],
      issueRefund: [{ refundId: "rf_A-100" }],
    },
  });

  expect(result.reachable).toBe(true);
});
