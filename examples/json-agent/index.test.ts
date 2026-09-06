import { assert, expect, test } from "vitest";
import { getInteraction, runAgent } from "@statelyai/agent";
import { jsonAgentMachine, workflowConfig } from "./index.js";

/** A drafting executor that fails the test if the escalate path reaches it. */
const noDraft = async () => {
  throw new Error("draftReply should not run on the escalate path");
};

test("workflow.json is real JSON data, not code", () => {
  expect(typeof workflowConfig).toBe("object");
  expect(workflowConfig.initial).toBe("triaging");
});

test("REPLY path: the draft settles idle, and APPROVE reaches the replied final state", async () => {
  const generateText = async () => ({ output: { reply: "Sorry about that — refund issued." } });
  const decide = async () => ({ event: { type: "REPLY" as const } });

  const first = await runAgent(jsonAgentMachine, {
    input: { ticket: "My invoice total looks wrong." },
    executors: { generateText, decide },
  });

  assert(first.status === "idle");
  expect(first.snapshot.matches("awaitingApproval")).toBe(true);
  // The idle state advertises both human moves through `meta.interaction`.
  expect(getInteraction(first.snapshot)?.events.map((choice) => choice.type)).toEqual([
    "APPROVE",
    "REJECT",
  ]);

  const second = await runAgent(jsonAgentMachine, {
    snapshot: first.snapshot,
    event: { type: "APPROVE" },
    executors: { generateText, decide },
  });

  assert(second.status === "done");
  expect(second.output).toEqual({
    resolution: "replied",
    reply: "Sorry about that — refund issued.",
  });
});

test("REJECT path: rejecting the draft escalates and keeps the drafted reply", async () => {
  const generateText = async () => ({ output: { reply: "Here is a workaround." } });
  const decide = async () => ({ event: { type: "REPLY" as const } });

  const first = await runAgent(jsonAgentMachine, {
    input: { ticket: "Third time this has broken." },
    executors: { generateText, decide },
  });

  assert(first.status === "idle");

  const second = await runAgent(jsonAgentMachine, {
    snapshot: first.snapshot,
    event: { type: "REJECT" },
    executors: { generateText, decide },
  });

  assert(second.status === "done");
  expect(second.output).toEqual({
    resolution: "escalated",
    escalationReason: "Reviewer rejected the drafted reply.",
    reply: "Here is a workaround.",
  });
});

test("ESCALATE path: the decision escalates directly, with no reply drafted", async () => {
  const decide = async () => ({ event: { type: "ESCALATE" as const, reason: "angry customer" } });

  const result = await runAgent(jsonAgentMachine, {
    input: { ticket: "This is unacceptable, get me a manager." },
    executors: { generateText: noDraft, decide },
  });

  assert(result.status === "done");
  // The decision's reason survives into the output — "escalated" alone tells
  // a reviewer nothing.
  expect(result.output).toEqual({
    resolution: "escalated",
    escalationReason: "angry customer",
    reply: undefined,
  });
});

test("a failing decision lands in the failed final state instead of a fake resolution", async () => {
  const decide = async () => {
    throw new Error("model unavailable");
  };

  const result = await runAgent(jsonAgentMachine, {
    input: { ticket: "Where is my order?" },
    executors: { generateText: noDraft, decide },
  });

  assert(result.status === "done");
  expect(result.output).toEqual({
    resolution: "failed",
    error: "Triage decision failed: model unavailable",
  });
});

test("a failing draft request lands in the failed final state", async () => {
  const generateText = async () => {
    throw new Error("rate limited");
  };
  const decide = async () => ({ event: { type: "REPLY" as const } });

  const result = await runAgent(jsonAgentMachine, {
    input: { ticket: "My invoice total looks wrong." },
    executors: { generateText, decide },
  });

  assert(result.status === "done");
  expect(result.output).toEqual({
    resolution: "failed",
    error: expect.stringContaining("Drafting the reply failed: "),
  });
});
