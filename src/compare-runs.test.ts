import { describe, expect, it } from "vitest";
import { compareRuns, type ParityRun } from "./compare-runs.js";

type Scenario = { id: string; expected?: string };

const runs =
  (table: Record<string, ParityRun>) =>
  async (scenario: Scenario): Promise<ParityRun> =>
    table[scenario.id]!;

describe("compareRuns", () => {
  it("labels a scenario 'same' when outcome and effects match", async () => {
    const run = { outcome: "issued", effects: [{ refund: 40 }] };
    const report = await compareRuns({
      scenarios: [{ id: "a" }],
      baseline: runs({ a: run }),
      candidate: runs({ a: { outcome: "issued", effects: [{ refund: 40 }] } }),
    });

    expect(report.scenarios[0]).toMatchObject({ id: "a", label: "same" });
    expect(report.counts).toEqual({ same: 1, intended: 0, regression: 0 });
    expect(report.ok).toBe(true);
  });

  it("labels a difference 'intended' when the baseline broke a rule and the candidate did not", async () => {
    const report = await compareRuns({
      scenarios: [{ id: "a" }],
      baseline: runs({ a: { outcome: "issued", violations: ["order-not-owned"] } }),
      candidate: runs({ a: { outcome: "escalated" } }),
    });

    expect(report.scenarios[0]).toMatchObject({ label: "intended" });
    expect(report.scenarios[0]!.reason).toContain("order-not-owned");
    expect(report.ok).toBe(true);
  });

  it("labels a fixed rule break 'intended' even when outcome and effects match", async () => {
    const report = await compareRuns({
      scenarios: [{ id: "a" }],
      baseline: runs({
        a: { outcome: "issued", effects: [40], violations: ["identity-not-verified"] },
      }),
      candidate: runs({ a: { outcome: "issued", effects: [40] } }),
    });

    expect(report.scenarios[0]).toMatchObject({ label: "intended" });
  });

  it("labels a difference 'intended' when only the candidate reaches the expected outcome", async () => {
    const report = await compareRuns({
      scenarios: [{ id: "a", expected: "closed" }],
      baseline: runs({ a: { outcome: "escalated" } }),
      candidate: runs({ a: { outcome: "closed" } }),
    });

    expect(report.scenarios[0]).toMatchObject({ label: "intended" });
  });

  it("labels any candidate violation a 'regression', even when the baseline broke the same rule", async () => {
    const run = { outcome: "issued", violations: ["identity-not-verified"] };
    const report = await compareRuns({
      scenarios: [{ id: "a" }],
      baseline: runs({ a: run }),
      candidate: runs({ a: run }),
    });

    expect(report.scenarios[0]).toMatchObject({ label: "regression" });
    expect(report.ok).toBe(false);
  });

  it("labels an unexplained outcome or effect difference a 'regression'", async () => {
    const report = await compareRuns({
      scenarios: [{ id: "outcome" }, { id: "effects" }, { id: "both-wrong", expected: "closed" }],
      baseline: runs({
        outcome: { outcome: "issued" },
        effects: { outcome: "issued", effects: { refund: 40 } },
        "both-wrong": { outcome: "issued" },
      }),
      candidate: runs({
        outcome: { outcome: "escalated" },
        effects: { outcome: "issued", effects: { refund: 400 } },
        "both-wrong": { outcome: "escalated" },
      }),
    });

    expect(report.scenarios.map((s) => [s.id, s.label])).toEqual([
      ["outcome", "regression"],
      ["effects", "regression"],
      ["both-wrong", "regression"],
    ]);
    expect(report.scenarios[0]!.reason).toBe("outcome differs: issued → escalated");
    expect(report.scenarios[1]!.reason).toBe("effects differ");
  });

  it("compares effects structurally, ignoring key order", async () => {
    const report = await compareRuns({
      scenarios: [{ id: "a" }],
      baseline: runs({ a: { outcome: "issued", effects: { orderId: "1", amount: 40 } } }),
      candidate: runs({ a: { outcome: "issued", effects: { amount: 40, orderId: "1" } } }),
    });

    expect(report.scenarios[0]!.label).toBe("same");
  });

  it("records a run that throws as a regression on the candidate side", async () => {
    const report = await compareRuns({
      scenarios: [{ id: "a" }],
      baseline: runs({ a: { outcome: "issued" } }),
      candidate: async () => {
        throw new Error("boom");
      },
    });

    expect(report.scenarios[0]).toMatchObject({
      label: "regression",
      candidate: { outcome: "threw" },
    });
    expect(report.scenarios[0]!.reason).toContain("boom");
  });
});
