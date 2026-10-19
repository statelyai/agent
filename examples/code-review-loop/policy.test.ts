/**
 * The POLICY on the real environment: v0 and v1 over every train and
 * held-out task, with mock author/reviewer/self-check executors, a fake
 * `runChecks`, and a mock judge behind `classifyIssue`.
 */
import { describe, expect, test } from "vitest";
import { createInMemoryEventLogStore } from "@statelyai/agent/log";
import { runBatch } from "./bench.js";
import { codeReviewLoopMachine } from "./environment.js";
import { triageRequestAt, probeContext, PROBE_CONTEXTS } from "./improve.js";
import {
  type IssueClassifier,
  createPolicyDecide,
  judgeClassifier,
  loadPolicy,
  lowerPolicy,
  policyInputOf,
  withPolicy,
} from "./policy.js";
import { HELD_OUT_TASKS, TRAIN_TASKS } from "./tasks.js";
import { fakeRunner, issueJudge, mockAuthorAndReviewer } from "./test-doubles.js";

const v0 = loadPolicy("v0");
const v1 = loadPolicy("v1");

async function measure(name: "v0" | "v1") {
  const judge = issueJudge();
  const decide = createPolicyDecide(loadPolicy(name), { classify: judgeClassifier(judge.model) });
  const store = createInMemoryEventLogStore();
  const options = {
    executors: withPolicy(mockAuthorAndReviewer(), decide),
    runner: fakeRunner,
    store,
    policyVersion: name,
  };
  return {
    train: await runBatch(`${name} train`, TRAIN_TASKS, options),
    heldOut: await runBatch(`${name} held-out`, HELD_OUT_TASKS, options),
    judgeCalls: judge.calls.length,
    store,
  };
}

const outcomes = (batch: Awaited<ReturnType<typeof measure>>["train"]) =>
  Object.fromEntries(batch.episodes.map((e) => [e.taskId, [e.outcome, e.rounds, e.score]]));

describe("policies", () => {
  test("both lower against the vocabulary", () => {
    expect(lowerPolicy(v0).id).toBe("review-policy-v0");
    expect(lowerPolicy(v1).id).toBe("review-policy-v1");
  });

  test("v0 retries a contradictory task to the round cap; v1 escalates it on round 1", async () => {
    const before = await measure("v0");
    const after = await measure("v1");

    expect(outcomes(before.train)).toEqual({
      clamp: ["shipped", 1, 0.95],
      slugify: ["shipped", 2, 0.9],
      chunk: ["shipped", 2, 0.9],
      "parse-duration": ["shipped", 2, 0.9],
      "round-half": ["escalated", 3, expect.closeTo(0.85)],
    });
    expect(outcomes(after.train)).toMatchObject({
      "round-half": ["escalated", 1, 0.95],
      "parse-duration": ["shipped", 2, 0.9],
    });
    expect(outcomes(after.heldOut)).toEqual({
      truncate: ["shipped", 2, 0.9],
      "capitalize-words": ["shipped", 1, 0.95],
      "merge-config": ["escalated", 1, 0.95],
    });

    console.log(
      `v0: train ${before.train.objective.toFixed(3)}, held-out ${before.heldOut.objective.toFixed(3)}; ` +
        `v1: train ${after.train.objective.toFixed(3)}, held-out ${after.heldOut.objective.toFixed(3)}`,
    );
    expect(before.train.objective).toBeCloseTo(0.9);
    expect(after.train.objective).toBeCloseTo(0.92);
    expect(before.heldOut.objective).toBeCloseTo(0.9);
    expect(after.heldOut.objective).toBeCloseTo(0.9333, 3);
    expect(before.train.violations + after.train.violations).toBe(0);
    // v0 never asks the judge; v1 asks once per triage that has review issues.
    expect(before.judgeCalls).toBe(0);
    expect(after.judgeCalls).toBeGreaterThan(0);

    // Every run is a thread named <split>/<policyVersion>/<taskId>.
    const { threadIds } = await after.store.listThreads!({ prefix: "held-out/v1/" });
    expect(threadIds).toEqual(HELD_OUT_TASKS.map((t) => `held-out/v1/${t.id}`).sort());
    const slugify = after.train.episodes.find((e) => e.taskId === "slugify")!;
    expect(slugify.trail).toEqual([
      "round 1: patch written",
      expect.stringMatching(/^round 1: (self-check|review)/),
      expect.stringMatching(/^round 1: (self-check|review)/),
      "round 1: checks failed: trims leading and trailing dashes",
      "round 1: RETRY (tests)",
      "round 2: patch written",
      expect.stringMatching(/^round 2: (self-check|review)/),
      expect.stringMatching(/^round 2: (self-check|review)/),
      "round 2: checks passed",
    ]);
  });

  test("a policy's input comes from the request the environment builds", () => {
    const input = policyInputOf(triageRequestAt(probeContext(PROBE_CONTEXTS[0]!)));
    expect(input.retry.all?.type).toBe("RETRY");
    expect(input.retry.tests?.feedback).toContain("Failing visible tests");
    expect(input.escalateReasons).toHaveLength(3);
    expect(input.payloads["RETRY"]).toHaveLength(3);
    // RETRY withheld: a novel issue.
    const novel = policyInputOf(triageRequestAt(probeContext(PROBE_CONTEXTS[3]!)));
    expect(novel.retry).toEqual({});
    expect(novel.retryBlocked).toMatch(/novel/);
    expect(codeReviewLoopMachine.id).toBe("code-review-loop");
  });

  test("aborting the outer decide aborts a pending classifyIssue call", async () => {
    let classifierSignal: AbortSignal | undefined;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => (markStarted = resolve));
    // Never answers on its own: it settles only when its signal aborts.
    const hanging: IssueClassifier = (_input, signal) => {
      classifierSignal = signal;
      markStarted();
      return new Promise((_, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    };
    const decide = createPolicyDecide(v1, { classify: hanging });
    const outer = new AbortController();
    const pending = Promise.resolve(
      decide(triageRequestAt(probeContext(PROBE_CONTEXTS[0]!)), { signal: outer.signal }),
    );
    pending.catch(() => {});
    await started;
    expect(classifierSignal?.aborted).toBe(false);
    outer.abort(new Error("run cancelled"));
    const settled = await Promise.race([
      pending.then(
        () => "resolved",
        () => "rejected",
      ),
      new Promise((resolve) => setTimeout(() => resolve("still pending"), 1_000)),
    ]);
    expect(settled).toBe("rejected");
    expect(classifierSignal?.aborted).toBe(true);
  });
});
