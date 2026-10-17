/**
 * Integration over the REAL desk (improve.test.ts drives a fake arm): the
 * playbooks, the improvement loop, and the demo's human-wait contract, all
 * through `refundDeskMachine` and its guards.
 */
import { describe, expect, test } from "vitest";
import {
  createAgentRuntime,
  getInteraction,
  runToQuiescence,
  type AgentDecisionExecutor,
} from "@statelyai/agent";
import { createMockJudge } from "../mock-judge.js";
import { createMockModelExecutors, type MockModelExecutors } from "../mock-model.js";
import { factsOf } from "./desk.js";
import {
  SCENARIOS,
  createDeskArm,
  createPlaybookDecide,
  createWorld,
  createWorldActors,
  loadPlaybook,
  refundDeskMachine,
  runBatch,
  runSelfImprovingRefundsExample,
} from "./index.js";
import type { PlaybookDecide } from "./playbook.js";

const v0 = loadPlaybook("v0");
const v1 = loadPlaybook("v1");

/** Says a ticket is a refund request unless it asks about a shipping address. */
const judge = () =>
  createMockJudge({
    isRefundRequest: (state) => !/shipping address/i.test((state as { ticket: string }).ticket),
  }).model;

/** The desk arm over a playbook decider. Counters are copied: the arm diffs two readings. */
const deskArm = (decide: PlaybookDecide) =>
  createDeskArm({
    label: decide.config.id ?? "playbook",
    decide,
    counters: () => ({ ...decide.counters }),
  });

/**
 * v0's model, played sloppy: refund the loaded order's total outright, else
 * look up the first order id, else ask. It never verifies identity or asks
 * for approval. v0's `chooseProposal` request carries the facts only in its
 * rendered prompt, so the script reads them from there.
 */
function sloppyModel(script: { proposePlaybook?: unknown } = {}): MockModelExecutors {
  return createMockModelExecutors({
    decisions: {
      chooseProposal: (request) => {
        const prompt = request.prompt ?? "";
        const total = prompt.match(/^Loaded order: ORD-\d{4} \(customer [^,]*, total (\d+)/m)?.[1];
        if (total) return { type: "ISSUE_REFUND", amount: Number(total) };
        const candidate = prompt.match(/^Order id candidates: (ORD-\d{4})/m)?.[1];
        if (candidate) return { type: "LOOKUP_ORDER", orderId: candidate };
        return { type: "ASK_CUSTOMER", question: "Which order is this about?" };
      },
    },
    ...(script.proposePlaybook !== undefined
      ? { text: { proposePlaybook: script.proposePlaybook as object } }
      : {}),
  });
}

/** Text and decisions that must never be called. */
const noModel = () => createMockModelExecutors({});

describe("playbooks on the real desk", () => {
  test("v1 is right on every scenario with no text-model call", async () => {
    const decide = createPlaybookDecide(v1, { executors: noModel(), judge: judge() });
    const metrics = await runBatch(deskArm(decide));

    expect(Object.fromEntries(metrics.episodes.map((e) => [e.scenarioId, e.outcome]))).toEqual(
      Object.fromEntries(SCENARIOS.map((s) => [s.id, s.expected])),
    );
    expect(metrics.accuracy).toBe(1);
    expect(metrics.violations).toBe(0);
    expect(metrics.modelCalls).toBe(0);
    expect(metrics.rejections).toBe(1);
    expect(metrics.judgeCalls).toBe(6);
  });

  test("a sloppy v0 model is refused by the guards: rejections, never violations", async () => {
    const decide = createPlaybookDecide(v0, { executors: sloppyModel(), judge: judge() });
    const metrics = await runBatch(deskArm(decide));

    expect(metrics.violations).toBe(0);
    expect(metrics.rejections).toBe(24);
    expect(metrics.modelCalls).toBe(33);
    expect(metrics.judgeCalls).toBe(0);
    // Only the scenarios whose right answer is "escalate" come out right.
    expect(metrics.accuracy).toBe(0.25);
    // Every ISSUE_REFUND it tries is unverified, so the desk escalates each one.
    expect(metrics.episodes.find((e) => e.scenarioId === "small-clean")?.trail).toContain(
      "turn 2: ISSUE_REFUND $40 rejected: identity not verified",
    );
  });
});

describe("one improvement round on the real desk", () => {
  test("v0 -> v1 passes every gate and is promoted", async () => {
    const log: string[] = [];
    const result = await runSelfImprovingRefundsExample({
      executors: sloppyModel({ proposePlaybook: v1 }),
      judge: judge(),
      log: (line) => log.push(line),
    });

    expect(result.gates.map((gate) => [gate.name, gate.ok])).toEqual([
      ["validate", true],
      ["vocabulary", true],
      ["lower", true],
      ["lint", true],
      ["terminates", true],
      ["outputs", true],
      ["replay", true],
    ]);
    expect(result.promoted).toBe(true);
    expect(result.config.id).toBe("refund-playbook-v1");

    const { before, after } = result;
    if (!after) throw new Error("expected a replay");
    expect(before.violations).toBe(0);
    expect(after.violations).toBe(0);
    expect(after.accuracy).toBe(1);
    expect(after.accuracy).toBeGreaterThan(before.accuracy);
    expect(after.modelCalls).toBe(0);
    const cost = (m: typeof before) => m.modelCalls + m.judgeCalls + m.rejections;
    expect([cost(before), cost(after)]).toEqual([57, 7]);
    expect(log.at(-1)).toBe("Promoted refund-playbook-v1.");
  });
});

describe("the demo contract", () => {
  test("the desk idles in askingIdentity with a renderable interaction and resumes from a persisted snapshot", async () => {
    const scenario = SCENARIOS.find((s) => s.id === "small-clean")!;
    const world = createWorld(scenario);
    // Verify first, then close: enough to cross one human wait.
    const decide: AgentDecisionExecutor = async (request) => ({
      event: factsOf(request).identityVerified
        ? { type: "CLOSE", reason: "verified, nothing else to do" }
        : { type: "VERIFY_IDENTITY" },
    });
    const runtime = () =>
      createAgentRuntime(refundDeskMachine, {
        executors: { decide },
        actors: createWorldActors(world),
      });

    const idle = await runToQuiescence(runtime(), {
      input: { ticket: scenario.ticket, customerId: scenario.customerId },
    });
    expect(idle.status).toBe("idle");
    expect(idle.snapshot.matches("askingIdentity")).toBe(true);
    const interaction = getInteraction(idle.snapshot);
    expect(interaction).not.toBeNull();
    expect(interaction?.textEvent).toBe("IDENTITY_CLAIM");

    const persisted = JSON.parse(JSON.stringify(idle.persist()));
    const done = await runToQuiescence(runtime(), {
      snapshot: persisted,
      event: { type: "IDENTITY_CLAIM", claim: scenario.identityClaim },
    });
    expect(done.status).toBe("done");
    if (done.status !== "done") return;
    expect(done.snapshot.context.identityVerified).toBe(true);
    expect(done.output.outcome).toBe("close");
    expect(typeof done.output.summary).toBe("string");
  });
});
