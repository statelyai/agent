import { describe, expect, test } from "vitest";
import type { AgentDecisionExecutor, AgentWorkflowConfig } from "@statelyai/agent";
import { createMockModelExecutors, type MockTextEntry } from "../mock-model.js";
import { HELD_OUT_SCENARIOS, SCENARIOS, summarize, type BatchMetrics } from "./contract.js";
import { createDeskArm, rejectionsFromLog } from "./desk.js";
import { improvePlaybook, objective, OBJECTIVE_WEIGHTS } from "./improve.js";
import { loadPlaybook, type PlaybookExecutors } from "./playbook.js";
import { eagerChoice, jevJudge } from "./test-doubles.js";

const v0 = loadPlaybook("v0");
const v1 = loadPlaybook("v1");

/** Reflection answers and the eager closed choices, from the shared mock model. */
function executors(proposals: MockTextEntry | MockTextEntry[]) {
  const text = createMockModelExecutors({
    text: { proposePlaybook: proposals },
    decisions: { "*": eagerChoice },
  });
  const executors: PlaybookExecutors = text;
  const prompts = () =>
    text.calls
      .filter((call) => call.name === "proposePlaybook")
      .map((call) => call.request.prompt ?? "");
  return { executors, prompts };
}

/** A config whose choice branch targets a state that does not exist. */
const badTarget: AgentWorkflowConfig = {
  ...v1,
  states: { ...v1.states, order: { type: "choice", choice: [{ target: "nowhere" }] } },
};

/** A config that invokes an actor outside the vocabulary. */
const unknownActor: AgentWorkflowConfig = {
  ...v1,
  states: {
    ...v1.states,
    classifying: {
      invoke: { src: "lookupCrm", onDone: { target: "intent" }, onError: { target: "done" } },
    },
  },
};

/** Proposes the same payout whatever the desk offers. */
const alwaysRefund: AgentWorkflowConfig = {
  id: "always-refund",
  context: { facts: "{{ input }}" },
  initial: "done",
  states: { done: { type: "final", output: { type: "ISSUE_REFUND", amount: 40 } } },
};

/** Always legal, always escalates: passes every static gate, then replays worse. */
const alwaysEscalate: AgentWorkflowConfig = {
  id: "always-escalate",
  context: { facts: "{{ input }}" },
  initial: "done",
  states: { done: { type: "final", output: { type: "ESCALATE", reason: "needs a person" } } },
};

const metrics = (overrides: Partial<BatchMetrics>): BatchMetrics => ({
  ...summarize("m", []),
  episodes: Array.from({ length: 8 }, () => ({}) as BatchMetrics["episodes"][number]),
  ...overrides,
});

describe("objective", () => {
  test("accuracy dominates, costs are small, a violation is -Infinity", () => {
    expect(objective(metrics({ accuracy: 1 }))).toBe(1);
    // One wrong ticket in eight outweighs six model calls per ticket.
    const wrong = objective(metrics({ accuracy: 7 / 8 }));
    const busy = objective(metrics({ accuracy: 1, modelCalls: 6 * 8 }));
    expect(busy).toBeGreaterThan(wrong);
    expect(objective(metrics({ accuracy: 1, judgeCalls: 8 }))).toBeCloseTo(
      1 - OBJECTIVE_WEIGHTS.judgeCall,
    );
    expect(objective(metrics({ accuracy: 1, violations: 1 }))).toBe(Number.NEGATIVE_INFINITY);
  });
});

describe("improvePlaybook", () => {
  test(
    "v0 -> v1: every gate passes and the better playbook is promoted",
    { timeout: 60_000 },
    async () => {
      const { executors: ex, prompts } = executors(v1);
      const result = await improvePlaybook({ current: v0, executors: ex, judge: jevJudge().model });

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
      expect(result.repairs).toBe(0);

      const { before, after } = result;
      if (!after) throw new Error("expected a replay");
      expect(before.all.violations).toBe(0);
      expect(after.all.violations).toBe(0);
      expect(after.train.accuracy).toBe(1);
      expect(after.heldOut.accuracy).toBe(1);
      expect(after.all.modelCalls).toBe(0);
      expect(objective(after.all)).toBeGreaterThan(objective(before.all));

      // The reflection prompt: goal, objective, environment, policy, train trails from the store.
      const [prompt] = prompts();
      expect(prompt).toContain("## Goal\nResolve each refund ticket correctly");
      expect(prompt).toContain("objective = accuracy - (0.02 * model calls");
      expect(prompt).toContain("## ENVIRONMENT (read-only");
      expect(prompt).toContain("Machine refund-desk\nGoal: Resolve each refund ticket");
      expect(prompt).toContain("## POLICY (yours to rewrite");
      expect(prompt).toContain("Machine refund-playbook-v0");
      expect(prompt).toContain('"id": "refund-playbook-v0"');
      expect(prompt).toContain("Named guards (read context.facts): identityRejected");
      expect(prompt).toContain("turn 1: LOOKUP_ORDER ORD-1001");
      // Held-out trails stay out of the prompt.
      for (const scenario of HELD_OUT_SCENARIOS) expect(prompt).not.toContain(scenario.id);

      // Every episode is a thread in the store, train and held-out under their own prefixes.
      const thread = await result.store.read("round-1/after/train/small-clean");
      expect(thread[0]?.event.type).toBe("@agent.init");
      const { threadIds } = await result.store.listThreads!({ prefix: "round-1/before/held-out/" });
      expect(threadIds).toHaveLength(HELD_OUT_SCENARIOS.length);
    },
  );

  test("rejections are counted from the log: refused proposals and failed checks", async () => {
    // Every turn's first try is an unoffered payout; the playbook answers the retry.
    const firstTrySloppy =
      (decide: AgentDecisionExecutor): AgentDecisionExecutor =>
      async (request, info) =>
        request.attempts.length === 0
          ? { event: { type: "ISSUE_REFUND", amount: 99_999 } }
          : decide(request, info);
    const { executors: ex, prompts } = executors(alwaysEscalate);
    const result = await improvePlaybook({
      current: v1,
      executors: ex,
      judge: jevJudge().model,
      arm: (decide, run) =>
        createDeskArm({
          label: "first-try-sloppy",
          name: "playbook",
          decide: firstTrySloppy(decide),
          store: run.store,
          threadPrefix: run.threadPrefix,
          counters: () => ({ ...decide.counters }),
        }),
    });

    const { threadIds } = await result.store.listThreads!({ prefix: "round-1/before/train/" });
    expect(threadIds).toHaveLength(SCENARIOS.length);
    let fromLog = 0;
    for (const threadId of threadIds)
      fromLog += rejectionsFromLog(await result.store.read(threadId));
    // At least one refused try per episode.
    expect(fromLog).toBeGreaterThanOrEqual(SCENARIOS.length);
    expect(result.before.train.rejections).toBe(fromLog);
    // Refused tries don't derail v1: their reasons never read as a failed identity check.
    expect(result.before.train.accuracy).toBe(1);

    // The reflection prompt shows the refused tries, read from the store.
    const [prompt] = prompts();
    expect(prompt).toContain("turn 1: refused ISSUE_REFUND $99999 (rejected-by-guard)");
    expect(prompt).toContain(`rejections ${fromLog},`);
  });

  test("failed gates feed back as repairs, then the current playbook stays", async () => {
    const { executors: ex, prompts } = executors([badTarget, unknownActor]);
    const result = await improvePlaybook({
      current: v0,
      executors: ex,
      judge: jevJudge().model,
      maxRepairs: 2,
    });

    expect(result.promoted).toBe(false);
    expect(result.config).toBe(v0);
    expect(result.repairs).toBe(2);
    expect(result.after).toBeUndefined();
    const failed = result.gates.find((gate) => !gate.ok);
    expect(failed?.name).toBe("vocabulary");
    expect(failed?.detail).toContain("unknown src 'lookupCrm'");

    const sent = prompts();
    expect(sent).toHaveLength(3);
    // The first repair names the bad target from the `lower` gate.
    expect(sent[1]).toContain("gate 'lower' failed");
    expect(sent[1]).toContain("nowhere");
    expect(sent[2]).toContain("gate 'vocabulary' failed");
  });

  test("a playbook that proposes options the desk does not offer fails the outputs gate", async () => {
    const { executors: ex } = executors(alwaysRefund);
    const result = await improvePlaybook({
      current: v1,
      executors: ex,
      judge: jevJudge().model,
      maxRepairs: 0,
    });
    expect(result.gates.at(-1)).toMatchObject({ name: "outputs", ok: false });
    expect(result.gates.at(-1)?.detail).toContain("matched no offered option");
    expect(result.promoted).toBe(false);
  });

  test("a playbook that passes the static gates but replays worse is not promoted", async () => {
    const { executors: ex } = executors(alwaysEscalate);
    const result = await improvePlaybook({ current: v1, executors: ex, judge: jevJudge().model });

    expect(result.gates.slice(0, -1).every((gate) => gate.ok)).toBe(true);
    expect(result.gates.at(-1)).toMatchObject({ name: "replay", ok: false });
    expect(result.gates.at(-1)?.detail).toContain("held-out objective fell");
    expect(result.promoted).toBe(false);
    expect(result.config).toBe(v1);
    expect(result.after!.all.accuracy).toBeLessThan(result.before.all.accuracy);
  });
});
