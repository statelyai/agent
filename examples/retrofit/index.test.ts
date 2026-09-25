import { expect, test } from "vitest";
import { type AgentRequestExecutors, type ChosenEvent } from "@statelyai/agent";
import { lintAgentMachine, simulateAgent } from "@statelyai/agent/testing";
import { createMockJevClient } from "../mock-jev.js";
import { MAX_LOOKUPS, runRetrofitExample, supportMachine } from "./index.js";

/**
 * The triage judgment's output, scripted for `simulateAgent` (which runs no
 * live actors): Jev's two `choice` answers.
 */
const TRIAGE = {
  answers: {
    category: { type: "choice", choice: "refund", confidence: 0.9, probabilities: {} },
    sentiment: { type: "choice", choice: "neutral", confidence: 0.9, probabilities: {} },
  },
  model: "jev-latest",
  usage: { input_tokens: 0, output_tokens: 0 },
};

/** The same triage through the real SDK client, for `runRetrofitExample`. */
const triageJev = () => createMockJevClient({ category: "refund", sentiment: "neutral" });

// ─── (a) the final machine is structurally sound ───

test("final machine lints clean", () => {
  lintAgentMachine(supportMachine, { throw: true });
});

// ─── (b) simulateAgent proves the refactor preserved before.ts behavior ───

test("preserves behavior: happy path — lookup then a small refund settles", async () => {
  const result = await simulateAgent(supportMachine, {
    input: { ticket: "Refund order A1001, arrived damaged." },
    script: {
      // Same two moves the loop's tool dispatch would take: look up, then refund.
      decisions: {
        "agent.decide": [
          { type: "LOOKUP", orderId: "A1001" },
          { type: "REFUND", amount: 50, reason: "damaged" },
        ],
      },
      // The lookupOrder actor's output, scripted (no live actor in simulation).
      invokes: {
        triageTicket: [TRIAGE],
        lookupOrder: ["Order A1001: Standing desk, $240, Ada Lovelace"],
      },
    },
  });

  expect(result.status).toBe("done");
  // The outcome IS the final state — there is no `refunded` boolean beside it.
  expect(result.snapshot.value).toBe("refunded");
  expect(result.snapshot.context.resolution).toContain("Refunded $50");
});

test("preserves behavior: escalation path — a large refund pauses for approval", async () => {
  const result = await simulateAgent(supportMachine, {
    input: { ticket: "Refund order A1001 for $5000." },
    script: {
      // The old `if (amount > 100)` branch: the guard routes this to the pause,
      // not a direct refund — enforced by construction, not by prompt.
      decisions: { "agent.decide": [{ type: "REFUND", amount: 5000, reason: "big" }] },
      invokes: { triageTicket: [TRIAGE] },
    },
  });

  expect(result.status).toBe("idle");
  expect(result.snapshot.value).toBe("awaitingApproval");
  expect(result.snapshot.context.pendingRefund).toBe(5000);
});

// ─── (c) a mock-executor run reaches the expected final state ───

// Mock host: `decide` plays scripted chosen events (triage is the Jev mock).
// Only the model calls are mocked; the machine is real.
function mockExecutors(events: ChosenEvent[]): Pick<AgentRequestExecutors, "decide"> {
  const queue = [...events];
  return {
    decide: async () => ({ event: queue.shift()! }),
  };
}

test("the lookup loop is bounded by MAX_LOOKUPS", async () => {
  const result = await simulateAgent(supportMachine, {
    input: { ticket: "Where is order A1001?" },
    script: {
      // The model keeps asking for lookups; after MAX_LOOKUPS the transition is
      // no longer taken, so the decision has to commit to an outcome.
      decisions: {
        "agent.decide": [
          { type: "LOOKUP", orderId: "A1001" },
          { type: "LOOKUP", orderId: "A1001" },
          { type: "RESOLVE", message: "It ships Tuesday." },
        ],
      },
      invokes: {
        triageTicket: [TRIAGE],
        lookupOrder: [
          "Order A1001: Standing desk, $240, Ada Lovelace",
          "Order A1001: Standing desk, $240, Ada Lovelace",
        ],
      },
    },
  });

  expect(result.status).toBe("done");
  expect(result.snapshot.value).toBe("resolved");
  expect(result.snapshot.context.lookups).toBe(MAX_LOOKUPS);
});

test("mock run reaches the refunded final state", async () => {
  const result = await runRetrofitExample({
    ticket: "Refund order B2002, $60.",
    executors: mockExecutors([{ type: "REFUND", amount: 60, reason: "defective" }]),
    jevClient: triageJev().client,
  });

  expect(result.settledIdle).toBe(false);
  expect(result.refunded).toBe(true);
  expect(result.resolution).toContain("Refunded $60");
  expect(result.progress.at(-1)).toBe("refunded");
});

test("mock run: large refund settles idle, then APPROVE resumes to refunded", async () => {
  const result = await runRetrofitExample({
    ticket: "Refund order A1001, $5000.",
    approve: true,
    executors: mockExecutors([{ type: "REFUND", amount: 5000, reason: "damaged" }]),
    jevClient: triageJev().client,
  });

  expect(result.settledIdle).toBe(true);
  expect(result.progress).toContain("awaitingApproval");
  expect(result.legalEvents).toEqual(expect.arrayContaining(["APPROVE", "DENY"]));
  expect(result.interactionLabel).toContain("exceeds the limit and needs approval");
  expect(result.refunded).toBe(true);
  expect(result.resolution).toContain("after approval");
  expect(result.progress.at(-1)).toBe("refunded");
});

test("triage asks Jev two choices over the ticket, and the decision reads the labels", async () => {
  const jev = createMockJevClient({ category: "complaint", sentiment: "negative" });
  const prompts: string[] = [];
  const result = await runRetrofitExample({
    ticket: "The keyboard from order B2002 double-types. Very annoying.",
    jevClient: jev.client,
    executors: {
      decide: async (request) => {
        prompts.push(request.prompt ?? "");
        return { event: { type: "RESOLVE", message: "Sending a replacement." } };
      },
    },
  });

  expect(jev.calls).toHaveLength(1);
  const call = jev.calls[0]!;
  expect(call.state).toEqual({
    ticket: "The keyboard from order B2002 double-types. Very annoying.",
  });
  expect(Object.keys(call.questions)).toEqual(["category", "sentiment"]);
  expect(Object.values(call.questions).every((question) => question.type === "choice")).toBe(true);
  expect(prompts[0]).toContain('"category":"complaint"');
  expect(prompts[0]).toContain('"sentiment":"negative"');
  expect(result.progress.at(-1)).toBe("resolved");
});
