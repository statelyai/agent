import { describe, expect, test } from "vitest";
import { lintAgentMachine } from "@statelyai/agent/testing";
import { createDecisionRequest, type AgentExecutorDecisionRequest } from "@statelyai/agent";
import { createMockJudge } from "../mock-judge.js";
import { createMockModelExecutors } from "../mock-model.js";
import { APPROVAL_THRESHOLD, PROPOSALS, type Facts, type Order } from "./contract.js";
import { createPlaybookDecide, loadPlaybook, lowerPlaybook } from "./playbook.js";

const v0 = loadPlaybook("v0");
const v1 = loadPlaybook("v1");

const ORDER: Order = {
  id: "ORD-1001",
  customerId: "C-1",
  total: 40,
  refunded: false,
  item: "USB-C cable",
};

function facts(overrides: Partial<Facts> = {}): Facts {
  return {
    ticket: "Hi, ORD-1001 arrived broken. Can I get my $40 back?",
    customerId: "C-1",
    identityVerified: true,
    order: ORDER,
    approved: false,
    orderIdCandidates: ["ORD-1001"],
    customerReplies: [],
    rejections: [],
    turn: 1,
    approvalThreshold: APPROVAL_THRESHOLD,
    ...overrides,
  };
}

function request(
  input: Facts,
  attempts: AgentExecutorDecisionRequest["attempts"] = [],
): AgentExecutorDecisionRequest {
  return {
    ...createDecisionRequest({ model: "playbook", input, events: PROPOSALS, attempts }),
    name: "desk",
  };
}

/** No text model on v1's path: any call fails the test. */
const noModel = {
  generateText: async () => {
    throw new Error("v1 should not call a text model");
  },
  decide: async () => {
    throw new Error("v1 should not call a decision model");
  },
};

function v1Decide(isRefundRequest = true) {
  const judge = createMockJudge({ isRefundRequest });
  return { decide: createPlaybookDecide(v1, { executors: noModel, judge: judge.model }), judge };
}

describe("playbooks lower and lint", () => {
  test.each([
    ["v0", v0],
    ["v1", v1],
  ])("%s", (_name, config) => {
    const machine = lowerPlaybook(config);
    // Errors throw; the one warning a config-built `agent.decide` carries
    // (`direct-object-src`) is advisory.
    const diagnostics = lintAgentMachine(machine, { throw: true });
    expect(diagnostics.filter((d) => d.code !== "direct-object-src")).toEqual([]);
  });
});

describe("v1: one proposal per branch, no text model", () => {
  test.each([
    ["unverified", facts({ identityVerified: false }), { type: "VERIFY_IDENTITY" }],
    [
      "verified, no order, a candidate",
      facts({ order: null }),
      { type: "LOOKUP_ORDER", orderId: "ORD-1001" },
    ],
    [
      "verified, no order, no candidate",
      facts({ order: null, orderIdCandidates: [] }),
      { type: "ASK_CUSTOMER", question: "Which order number is this about?" },
    ],
    [
      "wrong customer",
      facts({ order: { ...ORDER, customerId: "C-2" } }),
      { type: "ESCALATE", reason: "The order belongs to another customer." },
    ],
    [
      "already refunded",
      facts({ order: { ...ORDER, refunded: true } }),
      { type: "CLOSE", reason: "This order was already refunded." },
    ],
    [
      "large, unapproved",
      facts({ order: { ...ORDER, total: 240 } }),
      { type: "REQUEST_APPROVAL", amount: 240 },
    ],
    [
      "large, approved",
      facts({ order: { ...ORDER, total: 240 }, approved: true }),
      { type: "ISSUE_REFUND", amount: 240 },
    ],
    ["small", facts(), { type: "ISSUE_REFUND", amount: 40 }],
    [
      "identity rejected earlier",
      facts({
        identityVerified: false,
        rejections: [{ proposal: "VERIFY_IDENTITY", reason: "identity check failed" }],
      }),
      { type: "ESCALATE", reason: "Identity verification failed." },
    ],
  ])("%s", async (_name, input, expected) => {
    const { decide } = v1Decide();
    const { event } = await decide(request(input));
    expect(event).toEqual(expected);
    expect(decide.counters.modelCalls).toBe(0);
  });

  test("the judge says it is not a refund request: CLOSE, one judge call", async () => {
    const { decide, judge } = v1Decide(false);
    const { event } = await decide(request(facts()));
    expect(event).toEqual({ type: "CLOSE", reason: "Not a refund request." });
    expect(decide.counters).toEqual({ modelCalls: 0, judgeCalls: 1 });
    expect(judge.calls[0]?.state).toEqual({ ticket: facts().ticket, customerReplies: [] });
  });

  test("this turn's failed attempts merge into rejections", async () => {
    const { decide } = v1Decide();
    const { event } = await decide(
      request(facts({ identityVerified: false }), [
        {
          event: { type: "VERIFY_IDENTITY" },
          failure: "rejected-by-guard",
          reason: "'VERIFY_IDENTITY' is not currently takeable (guard rejected it).",
        },
      ]),
    );
    // Without the merge, v1 would propose VERIFY_IDENTITY again.
    expect(event.type).toBe("ESCALATE");
  });
});

describe("v0: the model chooses", () => {
  test("returns whatever the decision script chooses, one model call", async () => {
    const model = createMockModelExecutors({
      decisions: { chooseProposal: { type: "ISSUE_REFUND", amount: 40 } },
    });
    const decide = createPlaybookDecide(v0, { executors: model });
    const { event } = await decide(request(facts({ identityVerified: false })));
    expect(event).toEqual({ type: "ISSUE_REFUND", amount: 40 });
    expect(decide.counters).toEqual({ modelCalls: 1, judgeCalls: 0 });
  });

  test("the prompt carries rejections, including this turn's attempts", async () => {
    const model = createMockModelExecutors({
      decisions: { chooseProposal: { type: "ESCALATE", reason: "stuck" } },
    });
    const decide = createPlaybookDecide(v0, { executors: model });
    await decide(
      request(facts(), [
        {
          event: { type: "ISSUE_REFUND", amount: 40 },
          failure: "rejected-by-guard",
          reason: "nope",
        },
      ]),
    );
    expect(model.calls[0]?.request.prompt).toContain("Rejected so far: ISSUE_REFUND nope");
  });

  test("an exhausted decision takes the playbook's own onError", async () => {
    const decide = createPlaybookDecide(v0, {
      executors: {
        ...noModel,
        decide: async () => ({ event: { type: "NOT_A_PROPOSAL" } }),
      },
    });
    // Exhausted retries route to onError -> ESCALATE, which is still a proposal.
    const { event } = await decide(request(facts()));
    expect(event.type).toBe("ESCALATE");
    expect(decide.counters.modelCalls).toBe(3);
  });
});

test("a playbook that does not end done throws, naming the state", async () => {
  const decide = createPlaybookDecide(
    {
      id: "stuck",
      context: { facts: "{{ input }}" },
      initial: "waiting",
      states: { waiting: { on: { CLOSE: { target: "done" } } }, done: { type: "final" } },
    },
    { executors: noModel },
  );
  await expect(decide(request(facts()))).rejects.toThrow(
    "playbook 'stuck' settled 'idle' in \"waiting\"",
  );
});
