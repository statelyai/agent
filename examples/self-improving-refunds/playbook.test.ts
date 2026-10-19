import type { AgentDecisionRequest } from "@statelyai/agent";
import { describe, expect, test } from "vitest";
import { lintAgentMachine } from "@statelyai/agent/testing";
import { createMockJudge } from "../mock-judge.js";
import { createMockModelExecutors } from "../mock-model.js";
import { createPlaybookDecide, loadPlaybook, lowerPlaybook } from "./playbook.js";
import { eagerChoice, facts, ORDER, requestAt } from "./test-doubles.js";

const v0 = loadPlaybook("v0");
const v1 = loadPlaybook("v1");

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

/** True when `event` equals one of the request's offered options. */
const isOffered = (request: Awaited<ReturnType<typeof requestAt>>, event: object) =>
  (request.options ?? []).some(
    (option) => JSON.stringify(option.event) === JSON.stringify({ ...event }),
  );

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

describe("v1: one offered proposal per branch, no text model", () => {
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
      { type: "ESCALATE", reason: "order belongs to another customer" },
    ],
    [
      "already refunded",
      facts({ order: { ...ORDER, refunded: true } }),
      { type: "CLOSE", reason: "order already refunded" },
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
      { type: "ESCALATE", reason: "identity could not be verified" },
    ],
  ])("%s", async (_name, input, expected) => {
    const { decide } = v1Decide();
    const request = await requestAt(input);
    const { event } = await decide(request);
    expect(event).toEqual(expected);
    // Exactly one of the options the desk offered.
    expect(isOffered(request, event)).toBe(true);
    expect(decide.counters.modelCalls).toBe(0);
  });

  test("the judge says it is not a refund request: CLOSE, one judge call", async () => {
    const { decide, judge } = v1Decide(false);
    const { event } = await decide(await requestAt(facts()));
    expect(event).toEqual({ type: "CLOSE", reason: "not a refund request" });
    expect(decide.counters).toEqual({ modelCalls: 0, judgeCalls: 1 });
    expect(judge.calls[0]?.state).toEqual({ ticket: facts().ticket, customerReplies: [] });
  });

  test("this turn's failed attempts merge into rejections", async () => {
    const { decide } = v1Decide();
    const { event } = await decide(
      await requestAt(facts({ identityVerified: false }), [
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

describe("v0: the model chooses among the offered options", () => {
  test("its inner decision is the same closed choice, one model call", async () => {
    const model = createMockModelExecutors({ decisions: { "*": eagerChoice } });
    const decide = createPlaybookDecide(v0, { executors: model });
    const request = await requestAt(facts({ identityVerified: false }));
    const { event } = await decide(request);
    // ISSUE_REFUND is not legal yet, so the eager model cannot pick it.
    expect(event).toEqual({ type: "LOOKUP_ORDER", orderId: "ORD-1001" });
    expect(isOffered(request, event)).toBe(true);
    expect(decide.counters).toEqual({ modelCalls: 1, judgeCalls: 0 });
    expect(
      (model.calls[0]!.request as AgentDecisionRequest).options?.map(({ event: e }) => e),
    ).toEqual((request.options ?? []).map(({ event: e }) => e));
  });

  test("the prompt carries failures, including this turn's attempts", async () => {
    const model = createMockModelExecutors({ decisions: { "*": eagerChoice } });
    const decide = createPlaybookDecide(v0, { executors: model });
    await decide(
      await requestAt(facts(), [
        {
          event: { type: "ISSUE_REFUND", amount: 41 },
          failure: "rejected-by-guard",
          reason: "nope",
        },
      ]),
    );
    expect(model.calls[0]?.request.prompt).toContain("Failed so far: ISSUE_REFUND nope");
  });

  test("an exhausted inner decision takes the playbook's own onError", async () => {
    const decide = createPlaybookDecide(v0, {
      executors: { ...noModel, decide: async () => ({ event: { type: "NOT_A_PROPOSAL" } }) },
    });
    // Exhausted retries route to onError -> ESCALATE "needs a person", an offered option.
    const request = await requestAt(facts());
    const { event } = await decide(request);
    expect(event).toEqual({ type: "ESCALATE", reason: "needs a person" });
    expect(isOffered(request, event)).toBe(true);
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
  await expect(decide(await requestAt(facts()))).rejects.toThrow(
    "playbook 'stuck' settled 'idle' in \"waiting\"",
  );
});
