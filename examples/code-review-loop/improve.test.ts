/**
 * One improvement round over the REAL environment, with a mock reflection
 * model (examples/mock-model.ts keyed on `proposePolicy`), mock
 * author/reviewer executors, a fake `runChecks`, and a mock judge.
 */
import { describe, expect, test } from "vitest";
import type { AgentWorkflowConfig } from "@statelyai/agent";
import { scoreEpisode } from "./bench.js";
import { improvePolicy } from "./improve.js";
import { judgeClassifier, loadPolicy } from "./policy.js";
import { HELD_OUT_TASKS, TRAIN_TASKS } from "./tasks.js";
import { fakeRunner, issueJudge, mockAuthorAndReviewer } from "./test-doubles.js";
import type { MockTextEntry } from "../mock-model.js";

const v0 = loadPolicy("v0");
const v1 = loadPolicy("v1");

function improve(proposals: MockTextEntry | MockTextEntry[], current = v0, maxRepairs?: number) {
  const executors = mockAuthorAndReviewer({ proposePolicy: proposals });
  const prompts = () =>
    executors.calls
      .filter((call) => call.name === "proposePolicy")
      .map((c) => c.request.prompt ?? "");
  const run = improvePolicy({
    current,
    executors,
    classify: judgeClassifier(issueJudge().model),
    runner: fakeRunner,
    ...(maxRepairs !== undefined ? { maxRepairs } : {}),
  });
  return { run, prompts };
}

/** Always legal, always escalates: passes every static gate, then replays worse. */
const alwaysEscalate: AgentWorkflowConfig = {
  id: "always-escalate",
  context: { facts: "{{ input }}" },
  initial: "done",
  states: {
    done: { type: "final", output: { type: "ESCALATE", reason: "needs a design decision" } },
  },
};

/** Proposes a RETRY the environment never offers. */
const madeUpRetry: AgentWorkflowConfig = {
  id: "made-up-retry",
  context: { facts: "{{ input }}" },
  initial: "done",
  states: {
    done: { type: "final", output: { type: "RETRY", feedback: "try harder", focus: "all" } },
  },
};

/** Invokes an actor outside the vocabulary. */
const unknownActor: AgentWorkflowConfig = {
  ...v1,
  states: {
    ...v1.states,
    classifying: {
      invoke: { src: "runShell", onDone: { target: "routing" }, onError: { target: "retrying" } },
    },
  },
};

describe("objective", () => {
  test("per-task scores from ground truth", () => {
    const resolvable = { label: "resolvable" as const };
    const novel = { label: "novel-expected" as const };
    expect(
      scoreEpisode(resolvable, { outcome: "shipped", rounds: 1, hiddenPassed: true }),
    ).toBeCloseTo(0.95);
    expect(scoreEpisode(resolvable, { outcome: "shipped", rounds: 1, hiddenPassed: false })).toBe(
      0,
    );
    expect(
      scoreEpisode(resolvable, { outcome: "escalated", rounds: 1, hiddenPassed: null }),
    ).toBeCloseTo(0.45);
    expect(
      scoreEpisode(novel, { outcome: "escalated", rounds: 1, hiddenPassed: null }),
    ).toBeCloseTo(0.95);
    // Escalating a novel task is never worth less than shipping after the same rounds.
    for (const rounds of [1, 2, 3]) {
      expect(
        scoreEpisode(novel, { outcome: "escalated", rounds, hiddenPassed: null }),
      ).toBeGreaterThanOrEqual(
        scoreEpisode(resolvable, { outcome: "shipped", rounds, hiddenPassed: true }),
      );
    }
  });
});

describe("improvePolicy", () => {
  test(
    "v0 -> v1: every gate passes and the better policy is promoted",
    { timeout: 60_000 },
    async () => {
      const { run, prompts } = improve(v1);
      const result = await run;

      expect(result.gates.map((gate) => [gate.name, gate.ok])).toEqual([
        ["validate", true],
        ["vocabulary", true],
        ["lower", true],
        ["lint", true],
        ["explore", true],
        ["outputs", true],
        ["replay", true],
      ]);
      expect(result.promoted).toBe(true);
      expect(result.config).toBe(result.proposed);
      const { before, after } = result;
      expect(after!.all.objective).toBeGreaterThan(before.all.objective);
      expect(after!.heldOut.objective).toBeGreaterThan(before.heldOut.objective);
      expect(after!.all.violations).toBe(0);
      console.log(`improve: ${result.gates.at(-1)!.detail}`);

      // The reflection prompt: goal, objective, environment, policy, train trails from the store.
      const [prompt] = prompts();
      expect(prompt).toContain("## Goal\nShip a patch for each coding task");
      expect(prompt).toContain("escalated a novel-expected task = 1");
      expect(prompt).toContain("Machine code-review-loop\nGoal: Ship a patch");
      expect(prompt).toContain("Machine review-policy-v0");
      expect(prompt).toContain("### round-half: escalated after 3 round(s)");
      expect(prompt).toContain("round 1: RETRY (all)");
      // Held-out trails stay out of the prompt.
      for (const task of HELD_OUT_TASKS) expect(prompt).not.toContain(task.id);

      // Every run is a thread: <split>/<policyVersion>/<taskId>.
      const { threadIds } = await result.store.listThreads!({ prefix: "train/review-policy-v1/" });
      expect(threadIds).toHaveLength(TRAIN_TASKS.length);
    },
  );

  test("failed gates feed back as repairs, then the current policy stays", async () => {
    const { run, prompts } = improve([unknownActor, madeUpRetry], v0, 1);
    const result = await run;
    expect(result.promoted).toBe(false);
    expect(result.config).toBe(v0);
    expect(result.repairs).toBe(1);
    expect(result.after).toBeUndefined();
    expect(result.gates.at(-1)).toMatchObject({ name: "outputs", ok: false });
    expect(result.gates.at(-1)?.detail).toContain("is not an offered option");
    const sent = prompts();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain("gate 'vocabulary' failed");
    expect(sent[1]).toContain("runShell");
  });

  test(
    "a policy that passes the static gates but replays worse is not promoted",
    { timeout: 60_000 },
    async () => {
      const result = await improve(alwaysEscalate, v1).run;
      expect(result.gates.slice(0, -1).every((gate) => gate.ok)).toBe(true);
      expect(result.gates.at(-1)).toMatchObject({ name: "replay", ok: false });
      expect(result.gates.at(-1)?.detail).toContain("held-out objective fell");
      expect(result.promoted).toBe(false);
      expect(result.config).toBe(v1);
    },
  );
});
