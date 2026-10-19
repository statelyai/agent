/**
 * `runEpisode` scores the FINAL state: a person's APPROVE ships (and runs the
 * hidden tests); a person's REJECT, or no answer, scores as the escalation.
 */
import { describe, expect, test } from "vitest";
import type { AgentDecisionExecutor, ChosenEvent } from "@statelyai/agent";
import { runEpisode, type HumanReviewer } from "./bench.js";
import { withPolicy } from "./policy.js";
import { getTask } from "./tasks.js";
import { fakeRunner, mockAuthorAndReviewer } from "./test-doubles.js";

/** A policy that hands every task to a person on its first triage. */
const alwaysEscalate: AgentDecisionExecutor = async () => ({
  event: { type: "ESCALATE", reason: "needs a design decision" },
});

function episode(taskId: string, answers: ChosenEvent[]) {
  const queue = [...answers];
  const human: HumanReviewer = async () => queue.shift();
  return runEpisode(getTask(taskId), {
    executors: withPolicy(mockAuthorAndReviewer(), alwaysEscalate),
    runner: fakeRunner,
    human,
  });
}

describe("runEpisode scores the final state", () => {
  test("a person approves the draft: shipped, hidden tests run (and fail)", async () => {
    const e = await episode("slugify", [{ type: "APPROVE" }]);
    expect(e).toMatchObject({
      outcome: "shipped",
      rounds: 1,
      hiddenPassed: false,
      score: 0,
      finalState: "shipped",
    });
  });

  test("a person requests changes, then the loop ships: scored as a clean ship", async () => {
    const e = await episode("slugify", [{ type: "REQUEST_CHANGES", notes: "trim the dashes" }]);
    expect(e).toMatchObject({ outcome: "shipped", rounds: 2, hiddenPassed: true });
    expect(e.score).toBeCloseTo(0.9);
  });

  test("a person rejects a resolvable task: the escalation score (0.5)", async () => {
    const e = await episode("slugify", [{ type: "REJECT", reason: "no" }]);
    expect(e).toMatchObject({ outcome: "escalated", rounds: 1, hiddenPassed: null });
    expect(e.finalState).toBe("rejected");
    expect(e.score).toBeCloseTo(0.45);
  });

  test("a person rejects a novel task: a correct escalation (1)", async () => {
    const e = await episode("round-half", [{ type: "REJECT", reason: "spec is broken" }]);
    expect(e).toMatchObject({ outcome: "escalated", rounds: 1, finalState: "rejected" });
    expect(e.score).toBeCloseTo(0.95);
  });

  test("nobody answers: still escalated, waiting in humanReview", async () => {
    const e = await episode("round-half", []);
    expect(e).toMatchObject({ outcome: "escalated", rounds: 1, finalState: "humanReview" });
    expect(e.score).toBeCloseTo(0.95);
  });
});
