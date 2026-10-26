/**
 * The four suite-level eval helpers on the refund desk: repeated runs, suite
 * coverage, where failures start, and judge agreement. The decider is
 * deterministic but inconsistent: every other run of a scenario takes the
 * eager choice instead of the right one, the way a live model drifts between
 * runs.
 */
import { describe, expect, test } from "vitest";
import type { AgentDecisionExecutor, AgentTraceEvent } from "@statelyai/agent";
import {
  firstDivergence,
  foldTraces,
  judgeAgreement,
  repeatRuns,
  traceCoverage,
} from "@statelyai/agent/testing";
import { SCENARIOS, type Scenario } from "./contract.js";
import { refundDeskMachine, runDeskEpisode } from "./desk.js";
import { eagerChoice, isRefundTicket, rightPath } from "./test-doubles.js";

const eager: AgentDecisionExecutor = async (request) => ({ event: eagerChoice(request) });

async function episode(scenario: Scenario, decide: AgentDecisionExecutor) {
  const trace: AgentTraceEvent[] = [];
  const metrics = await runDeskEpisode(scenario, { decide, onTrace: (event) => trace.push(event) });
  return { trace, outcome: metrics.outcome };
}

const report = await repeatRuns({
  scenarios: SCENARIOS,
  k: 4,
  run: (scenario, attempt) => episode(scenario, attempt % 2 === 0 ? rightPath : eager),
  passed: (scenario, { outcome }) => outcome === scenario.expected,
});

describe("refund desk evals", () => {
  test("repeated runs: pass^4 is below the single-run rate", () => {
    const unreliable = report.scenarios.filter((row) => !row.passAll).map((row) => row.id);

    expect(unreliable).toEqual([
      "small-clean",
      "large-approved",
      "already-refunded",
      "not-a-refund",
    ]);
    expect(report.passHat(1)).toBe(0.75);
    expect(report.passHat(4)).toBe(0.5);
    // Every scenario's runs split at the decision, including the ones that
    // still pass: the eager decider takes a different path to the same outcome.
    expect(new Set(report.scenarios.map((row) => row.divergedAt))).toEqual(new Set(["deciding"]));
  });

  test("suite coverage: the sentinel and the failure handlers are never exercised", () => {
    const coverage = traceCoverage(refundDeskMachine, report.traces);

    // No run issued a refund illegally, which is what the sentinel guards.
    expect(coverage.unvisitedStates).toEqual(["illegallyIssued"]);
    // No scenario makes a tool fail or the decider give up: draft scenarios for these.
    expect(coverage.unvisitedHandlers).toEqual([
      { state: "deciding", event: "GIVE_UP" },
      { state: "verifyingIdentity", event: "xstate.error.actor" },
      { state: "lookingUp", event: "xstate.error.actor" },
      { state: "issuing", event: "xstate.error.actor" },
    ]);
    // Eventless checks run inside a step, so traces cannot show them.
    expect(coverage.unobservable).toEqual([
      { state: "checkingBudget", event: "always" },
      { state: "checkingIssue", event: "always" },
    ]);
  });

  test("where failures start: blame lands on the decision, not on what followed", async () => {
    const references = new Map<string, AgentTraceEvent[]>();
    for (const scenario of SCENARIOS) {
      references.set(scenario.id, (await episode(scenario, rightPath)).trace);
    }
    const runs = report.scenarios.flatMap((row) =>
      row.runs.map((run) => ({ id: row.id, passed: run.passed, trace: run.trace! })),
    );
    const scenarioOf = new Map(runs.map((run) => [run.trace, run]));

    const stats = foldTraces(
      runs.map((run) => run.trace),
      {
        failed: (trace) => !scenarioOf.get(trace)!.passed,
        blame: (trace) => firstDivergence(trace, references.get(scenarioOf.get(trace)!.id)!)?.state,
      },
    );

    const blamed = stats.filter((row) => row.blamed > 0);
    expect(blamed.map(({ state, blamed }) => ({ state, blamed }))).toEqual([
      { state: "deciding", blamed: 8 },
    ]);
    // `failures` counts the same runs against every state they passed through.
    expect(stats.filter((row) => row.failures === 8).length).toBeGreaterThan(1);
  });

  test("judge agreement: a keyword judge finds every refund and passes most non-refunds", () => {
    // Should the desk refund this ticket? People labeled it (`expected`); the
    // judge reads the ticket's words.
    const agreement = judgeAgreement(
      SCENARIOS.map((scenario) => ({
        id: scenario.id,
        human: scenario.expected === "refund" ? "refund" : "no-refund",
        judge: isRefundTicket(scenario.ticket) ? "refund" : "no-refund",
      })),
      { positive: "refund" },
    );

    expect(agreement.binary).toEqual({ tpr: 1, tnr: 0.2 });
    expect(agreement.disagreements.map((row) => row.id)).toEqual([
      "large-rejected",
      "already-refunded",
      "wrong-customer",
      "identity-fails",
    ]);
    // TPR + TNR > 1, so the judge carries some signal. It flags most tickets,
    // so its rate overstates refunds: flagging 90% of unlabeled tickets means
    // (0.9 + 0.2 − 1) / (1 + 0.2 − 1) = 50% should be refunded.
    expect(agreement.correct?.(0.9)).toBeCloseTo(0.5);
  });
});
