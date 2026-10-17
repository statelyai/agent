import { describe, expect, test } from "vitest";
import { createDecisionRequest, type AgentWorkflowConfig } from "@statelyai/agent";
import { createMockJudge } from "../mock-judge.js";
import { createMockModelExecutors, type MockTextEntry } from "../mock-model.js";
import {
  APPROVAL_THRESHOLD,
  createWorld,
  findOrderIds,
  MAX_REJECTIONS,
  MAX_TURNS,
  PROPOSALS,
  type Arm,
  type Facts,
  type Outcome,
  type World,
} from "./contract.js";
import { improvePlaybook } from "./improve.js";
import { loadPlaybook, type PlaybookDecide } from "./playbook.js";

const v0 = loadPlaybook("v0");
const v1 = loadPlaybook("v1");

type Step = { refusal?: string; outcome?: Outcome };

/**
 * A stand-in for the desk's guard table: refuses illegal proposals (so
 * violations stay empty) and applies legal ones to the facts and the world.
 */
function applyProposal(
  event: { type: string; [key: string]: unknown },
  facts: Facts,
  world: World,
): Step {
  const order = facts.order;
  switch (event.type) {
    case "VERIFY_IDENTITY": {
      if (facts.identityVerified) return { refusal: "identity already verified" };
      if (!world.verifyIdentity(world.identityClaim())) {
        return { refusal: "identity check failed" };
      }
      facts.identityVerified = true;
      return {};
    }
    case "LOOKUP_ORDER": {
      const found = world.lookupOrder(String(event.orderId));
      if (!found) return { refusal: `no order ${String(event.orderId)}` };
      facts.order = { ...found };
      return {};
    }
    case "ASK_CUSTOMER": {
      facts.customerReplies.push(world.customerReply(String(event.question)));
      facts.orderIdCandidates = findOrderIds([facts.ticket, ...facts.customerReplies].join(" "));
      return {};
    }
    case "REQUEST_APPROVAL": {
      if (!order || facts.approved || order.total <= facts.approvalThreshold) {
        return { refusal: "approval not needed" };
      }
      if (world.requestApproval(Number(event.amount)) === "reject") return { outcome: "close" };
      facts.approved = true;
      return {};
    }
    case "ISSUE_REFUND": {
      if (!facts.identityVerified) return { refusal: "identity not verified" };
      if (!order) return { refusal: "no order loaded" };
      if (order.customerId !== facts.customerId)
        return { refusal: "order belongs to another customer" };
      if (order.refunded) return { refusal: "already refunded" };
      if (order.total > facts.approvalThreshold && !facts.approved)
        return { refusal: "needs approval" };
      world.issueRefund({
        orderId: order.id,
        amount: order.total,
        identityVerified: facts.identityVerified,
        approved: facts.approved,
      });
      return { outcome: "refund" };
    }
    case "ESCALATE":
      return { outcome: "escalate" };
    default:
      return { outcome: "close" };
  }
}

/** The fake arm: drives the decider over a scripted Facts progression per scenario. */
function fakeArm(decide: PlaybookDecide): Arm {
  return {
    label: decide.config.id ?? "playbook",
    async runEpisode(scenario) {
      const world = createWorld(scenario);
      const start = { ...decide.counters };
      const facts: Facts = {
        ticket: scenario.ticket,
        customerId: scenario.customerId,
        identityVerified: false,
        order: null,
        approved: false,
        orderIdCandidates: findOrderIds(scenario.ticket),
        customerReplies: [],
        rejections: [],
        turn: 0,
        approvalThreshold: APPROVAL_THRESHOLD,
      };
      const trail: string[] = [];
      let outcome: Outcome = "failed";
      let turns = 0;
      while (outcome === "failed" && turns < MAX_TURNS) {
        turns += 1;
        facts.turn = turns;
        let event;
        try {
          ({ event } = await decide({
            ...createDecisionRequest({
              id: `turn-${turns}`,
              model: "playbook",
              input: structuredClone(facts),
              events: PROPOSALS,
            }),
            name: "desk",
          }));
        } catch (error) {
          trail.push(`turn ${turns}: decider failed: ${(error as Error).message}`);
          break;
        }
        const step = applyProposal(event, facts, world);
        if (step.refusal) {
          facts.rejections.push({ proposal: event.type, reason: step.refusal });
          trail.push(`turn ${turns}: ${event.type} rejected: ${step.refusal}`);
          if (facts.rejections.length >= MAX_REJECTIONS) outcome = "escalate";
          continue;
        }
        trail.push(`turn ${turns}: ${event.type}`);
        if (step.outcome) outcome = step.outcome;
      }
      return {
        scenarioId: scenario.id,
        outcome,
        correct: outcome === scenario.expected,
        turns,
        modelCalls: decide.counters.modelCalls - start.modelCalls,
        judgeCalls: decide.counters.judgeCalls - start.judgeCalls,
        rejections: facts.rejections.length,
        violations: world.violations,
        trail,
      };
    },
  };
}

/** Says a ticket is a refund request unless it asks about shipping. */
const judge = () =>
  createMockJudge({
    isRefundRequest: (state) => !/shipping address/i.test((state as { ticket: string }).ticket),
  }).model;

/** v0's model: always tries to refund straight away. */
function executors(proposals: MockTextEntry | MockTextEntry[]) {
  return createMockModelExecutors({
    decisions: { chooseProposal: { type: "ISSUE_REFUND", amount: 40 } },
    text: { proposePlaybook: proposals },
  });
}

/** A config whose choice branch targets a state that does not exist. */
const badTarget: AgentWorkflowConfig = {
  ...v1,
  states: {
    ...v1.states,
    order: { type: "choice", choice: [{ target: "nowhere" }] },
  },
};

/** A config that invokes an actor outside the vocabulary. */
const unknownActor: AgentWorkflowConfig = {
  ...v1,
  states: {
    ...v1.states,
    classifying: {
      invoke: {
        src: "lookupCrm",
        onDone: { target: "intent" },
        onError: { target: "done" },
      },
    },
  },
};

/** Statically fine, behaviorally reckless: refund every time. */
const alwaysRefund: AgentWorkflowConfig = {
  id: "always-refund",
  context: { facts: "{{ input }}" },
  initial: "done",
  states: { done: { type: "final", output: { type: "ISSUE_REFUND", amount: 40 } } },
};

describe("improvePlaybook", () => {
  test("v0 -> v1: every gate passes and the cheaper playbook is promoted", async () => {
    const model = executors(v1);
    const result = await improvePlaybook({
      current: v0,
      arm: fakeArm,
      executors: model,
      judge: judge(),
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
    expect(result.config).toBe(result.proposed);
    expect(result.repairs).toBe(0);

    const { before, after } = result;
    if (!after) throw new Error("expected a replay");
    expect(after.violations).toBe(0);
    expect(after.accuracy).toBeGreaterThan(before.accuracy);
    expect(after.modelCalls).toBe(0);
    expect(after.rejections).toBeLessThan(before.rejections);
    expect(after.modelCalls + after.judgeCalls + after.rejections).toBeLessThan(
      before.modelCalls + before.judgeCalls + before.rejections,
    );

    // The reflection prompt carried the vocabulary, the current config, and the trails.
    const prompt = model.calls.find((call) => call.name === "proposePlaybook")?.request.prompt;
    expect(prompt).toContain("Named guards (read context.facts): identityRejected");
    expect(prompt).toContain('"id": "refund-playbook-v0"');
    expect(prompt).toContain("ISSUE_REFUND rejected: identity not verified");
  });

  test("failed gates feed back as repairs, then the current playbook stays", async () => {
    const model = executors([badTarget, unknownActor]);
    const result = await improvePlaybook({
      current: v0,
      arm: fakeArm,
      executors: model,
      judge: judge(),
      maxRepairs: 2,
    });

    expect(result.promoted).toBe(false);
    expect(result.config).toBe(v0);
    expect(result.repairs).toBe(2);
    expect(result.after).toBeUndefined();
    const failed = result.gates.find((gate) => !gate.ok);
    expect(failed?.name).toBe("vocabulary");
    expect(failed?.detail).toContain("unknown src 'lookupCrm'");

    const prompts = model.calls
      .filter((call) => call.name === "proposePlaybook")
      .map((call) => call.request.prompt ?? "");
    expect(prompts).toHaveLength(3);
    // The first repair names the bad target from the `lower` gate.
    expect(prompts[1]).toContain("gate 'lower' failed");
    expect(prompts[1]).toContain("'nowhere'");
    expect(prompts[2]).toContain("gate 'vocabulary' failed");
  });

  test("a playbook that passes the static gates but replays worse is not promoted", async () => {
    const result = await improvePlaybook({
      current: v1,
      arm: fakeArm,
      executors: executors(alwaysRefund),
      judge: judge(),
    });

    expect(result.gates.slice(0, -1).every((gate) => gate.ok)).toBe(true);
    expect(result.gates.at(-1)).toMatchObject({ name: "replay", ok: false });
    expect(result.gates.at(-1)?.detail).toContain("accuracy fell");
    expect(result.promoted).toBe(false);
    expect(result.config).toBe(v1);
    expect(result.after?.accuracy).toBeLessThan(result.before.accuracy);
  });
});
