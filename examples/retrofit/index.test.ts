import { expect, test } from "vitest";
import {
  lintAgentMachine,
  simulateAgent,
  type AgentRequestExecutors,
  type ChosenEvent,
} from "@statelyai/agent";
import { runRetrofitExample, supportMachine } from "./index.js";

const TRIAGE = { category: "refund", sentiment: "neutral", summary: "Damaged item refund" };

// ─── (a) the final machine is structurally sound ───

test("final machine lints clean", () => {
  lintAgentMachine(supportMachine, { throw: true });
});

// ─── (b) simulateAgent proves the refactor preserved before.ts behavior ───

test("preserves behavior: happy path — lookup then a small refund settles", async () => {
  const result = await simulateAgent(supportMachine, {
    input: { ticket: "Refund order A1001, arrived damaged." },
    script: {
      text: { triageTicket: [TRIAGE] },
      // Same two moves the loop's tool dispatch would take: look up, then refund.
      decisions: {
        "agent.decide": [
          { type: "LOOKUP", orderId: "A1001" },
          { type: "REFUND", amount: 50, reason: "damaged" },
        ],
      },
      // The lookupOrder actor's output, scripted (no live actor in simulation).
      invokes: { lookupOrder: ["Order A1001: Standing desk, $240, Ada Lovelace"] },
    },
  });

  expect(result.status).toBe("done");
  expect(result.snapshot.value).toBe("refunded");
  expect(result.snapshot.context.refunded).toBe(true);
  expect(result.snapshot.context.resolution).toContain("Refunded $50");
});

test("preserves behavior: escalation path — a large refund pauses for approval", async () => {
  const result = await simulateAgent(supportMachine, {
    input: { ticket: "Refund order A1001 for $5000." },
    script: {
      text: { triageTicket: [TRIAGE] },
      // The old `if (amount > 100)` branch: the guard routes this to the pause,
      // not a direct refund — enforced by construction, not by prompt.
      decisions: { "agent.decide": [{ type: "REFUND", amount: 5000, reason: "big" }] },
    },
  });

  expect(result.status).toBe("idle");
  expect(result.snapshot.value).toBe("awaitingApproval");
  expect(result.snapshot.context.refunded).toBe(false);
  expect(result.snapshot.context.pendingRefund).toBe(5000);
});

// ─── (c) a mock-executor run reaches the expected final state ───

// Mock host: `generateText` answers the triage request; `decide` plays scripted
// chosen events. Only the model calls are mocked; the machine is real.
function mockExecutors(
  events: ChosenEvent[],
): Pick<AgentRequestExecutors, "generateText" | "decide"> {
  const queue = [...events];
  return {
    generateText: async (request: { name?: string }) => {
      if (request.name === "triageTicket") return { output: TRIAGE };
      throw new Error(`unexpected generateText request: ${request.name}`);
    },
    decide: async () => ({ event: queue.shift()! }),
  };
}

test("mock run reaches the refunded final state", async () => {
  const result = await runRetrofitExample({
    ticket: "Refund order B2002, $60.",
    executors: mockExecutors([{ type: "REFUND", amount: 60, reason: "defective" }]),
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
  });

  expect(result.settledIdle).toBe(true);
  expect(result.progress).toContain("awaitingApproval");
  expect(result.legalEvents).toEqual(expect.arrayContaining(["APPROVE", "DENY"]));
  expect(result.interactionLabel).toContain("exceeds the limit and needs approval");
  expect(result.refunded).toBe(true);
  expect(result.resolution).toContain("after approval");
  expect(result.progress.at(-1)).toBe("refunded");
});
