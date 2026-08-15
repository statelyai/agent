import { describe, expect, test } from "vitest";
import {
  canReach,
  explorePaths,
  lintAgentMachine,
  matchesTrajectory,
  runAgent,
  simulateAgent,
} from "@statelyai/agent";
import type { AgentDecisionRequest, ChosenEvent } from "@statelyai/agent";
import { APPROVAL_THRESHOLD, refundMachine } from "./index.js";

const LARGE = { amount: 500, reason: "Duplicate annual charge" };
const SMALL = { amount: 40, reason: "Late delivery credit" };

/** A decide executor that plays a fixed script of event types in order. */
function scriptedDecide(script: string[]) {
  let i = 0;
  return async (_request: AgentDecisionRequest): Promise<{ event: ChosenEvent }> => {
    const type = script[i++] ?? "REFUSE";
    return { event: { type, reasoning: `scripted ${type}` } };
  };
}

describe("verification", () => {
  test("lint is clean", () => {
    expect(lintAgentMachine(refundMachine)).toEqual([]);
  });

  test("canReach proves the violation state unreachable at any amount", async () => {
    for (const input of [LARGE, SMALL, { amount: APPROVAL_THRESHOLD, reason: "at the limit" }]) {
      const result = await canReach(refundMachine, "illegallyIssued", { input });
      expect(result.reachable, `illegallyIssued reachable at $${input.amount}`).toBe(false);
      expect(result.witness).toBeUndefined();
    }
  });

  test("canReach proves 'issued' reachable, and only via the human gate when large", async () => {
    const large = await canReach(refundMachine, "issued", { input: LARGE });
    expect(large.reachable).toBe(true);
    // The only route to a $500 payout runs through approving.
    expect(large.witness?.map((event) => event.type)).toEqual(["ESCALATE", "APPROVE"]);

    const small = await canReach(refundMachine, "issued", { input: SMALL });
    expect(small.reachable).toBe(true);
    expect(small.witness?.map((event) => event.type)).toEqual(["ISSUE"]);
  });

  test("the violation stated as a snapshot predicate needs no sentinel state", async () => {
    type Ctx = { amount: number; approved: boolean };
    const violation = await canReach(
      refundMachine,
      (snapshot) =>
        snapshot.matches("issued") &&
        (snapshot.context as Ctx).amount > APPROVAL_THRESHOLD &&
        !(snapshot.context as Ctx).approved,
      { input: LARGE },
    );
    expect(violation.reachable).toBe(false);

    // The predicate's legal counterpart: issued WITH approval on record.
    const legal = await canReach(
      refundMachine,
      (snapshot) => snapshot.matches("issued") && (snapshot.context as Ctx).approved,
      { input: LARGE },
    );
    expect(legal.reachable).toBe(true);
    expect(legal.witness?.map((event) => event.type)).toEqual(["ESCALATE", "APPROVE"]);
  });

  test("explorePaths prunes the guarded ISSUE above the threshold, not below", async () => {
    const large = await explorePaths(refundMachine, { input: LARGE });
    expect(large.prunedByGuard).toBe(1);
    expect(large.terminals.every((terminal) => terminal.status === "done")).toBe(true);
    expect(large.terminals.map((terminal) => terminal.state).sort()).toEqual([
      "issued",
      "refused",
      "rejected",
    ]);
    // No path anywhere in the enumeration lands on the violation state.
    expect(large.reachedStates).not.toContain("illegallyIssued");

    const small = await explorePaths(refundMachine, { input: SMALL });
    expect(small.prunedByGuard).toBe(0);
    expect(small.terminals.filter((terminal) => terminal.state === "issued")).toHaveLength(2);
  });

  test("simulateAgent: an adversarial ISSUE exhausts into refused, the same choice passes below the limit", async () => {
    const script = { decisions: { "agent.decide": [{ type: "ISSUE", reasoning: "pay it" }] } };

    const adversarial = await simulateAgent(refundMachine, { input: LARGE, script });
    // The guard rejects ISSUE; the queue is retried like a live run re-asks
    // the model, exhausts, and the error routes via onError to `refused`.
    expect(adversarial.status).toBe("done");
    expect(adversarial.snapshot.value).toBe("refused");
    expect(adversarial.trail.map((entry) => entry.state)).toEqual(["classifying", "refused"]);
    expect(adversarial.trail.at(-1)?.rejectedEvents).toEqual([
      { type: "ISSUE", reasoning: "pay it" },
    ]);

    const legal = await simulateAgent(refundMachine, { input: SMALL, script });
    expect(legal.status).toBe("done");
    expect(legal.snapshot.value).toBe("issued");
  });

  test("simulateAgent: scripted external APPROVE crosses the human gate to issued", async () => {
    const result = await simulateAgent(refundMachine, {
      input: LARGE,
      script: {
        decisions: { "agent.decide": [{ type: "ESCALATE", reasoning: "over the limit" }] },
        events: [{ type: "APPROVE", approver: "ops" }],
      },
    });

    expect(result.status).toBe("done");
    expect(result.snapshot.value).toBe("issued");
    expect(result.snapshot.context.approved).toBe(true);
    expect(result.trail.map((entry) => entry.state)).toEqual([
      "classifying",
      "approving",
      "issued",
    ]);
    expect(result.trail.at(-1)).toEqual(
      expect.objectContaining({
        appliedEvent: expect.objectContaining({ type: "APPROVE" }),
        external: true,
      }),
    );
  });

  test("a live run rejects the adversarial choice by guard and still completes legally", async () => {
    const requests: AgentDecisionRequest[] = [];
    const decide = async (request: AgentDecisionRequest): Promise<{ event: ChosenEvent }> => {
      requests.push(request);
      // First attempt cheats; the retry escalates.
      const type = requests.length === 1 ? "ISSUE" : "ESCALATE";
      return { event: { type, reasoning: `scripted ${type}` } };
    };

    const idle = await runAgent(refundMachine, { input: LARGE, executors: { decide } });
    expect(idle.status).toBe("idle");
    if (idle.status !== "idle") throw new Error("expected idle");
    expect(idle.snapshot.value).toBe("approving");
    expect(requests[1]!.attempts.at(-1)!.failure).toBe("rejected-by-guard");

    // The human approves; only now can the payout happen.
    const done = await runAgent(refundMachine, {
      snapshot: idle.snapshot,
      event: { type: "APPROVE", approver: "ops" },
      executors: { decide },
    });
    expect(done.status).toBe("done");
    if (done.status !== "done") throw new Error("expected done");
    expect(done.output.outcome).toBe("issued");
    expect(done.output.approved).toBe(true);
  });

  test("a small refund runs straight through without a human", async () => {
    const result = await runAgent(refundMachine, {
      input: SMALL,
      executors: { decide: scriptedDecide(["ISSUE"]) },
    });
    expect(result.status).toBe("done");
    if (result.status !== "done") throw new Error("expected done");
    expect(result.output.outcome).toBe("issued");
    expect(result.output.approved).toBe(false);
  });

  test("matchesTrajectory scores the simulated state paths, hit and miss", async () => {
    const script = { decisions: { "agent.decide": [{ type: "ISSUE", reasoning: "pay it" }] } };
    const legal = await simulateAgent(refundMachine, { input: SMALL, script });
    const adversarial = await simulateAgent(refundMachine, { input: LARGE, script });

    // The trail already begins with the initial state — a complete state path.
    const pathOf = (result: { trail: { state: unknown }[] }) =>
      result.trail.map((entry) => entry.state);

    const hit = matchesTrajectory(pathOf(legal), ["classifying", "issued"]);
    expect(hit.matched).toBe(true);
    expect(hit.score).toBe(1);

    const miss = matchesTrajectory(pathOf(adversarial), ["classifying", "issued"]);
    expect(miss.matched).toBe(false);
    expect(miss.firstMiss?.index).toBe(1);
    expect(miss.firstMiss?.expected).toBe("issued");
  });
});
