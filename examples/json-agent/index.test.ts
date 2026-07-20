import { expect, test } from "vitest";
import { runAgent } from "@statelyai/agent";
import { jsonAgentMachine, workflowConfig } from "./index.js";

test("workflow.json is real JSON data, not code", () => {
  expect(typeof workflowConfig).toBe("object");
  expect(workflowConfig.initial).toBe("triaging");
});

test("REPLY path: decide drafts a reply, settles idle, resumes on human APPROVE", async () => {
  const generateText = async () => ({ output: { reply: "Sorry about that — refund issued." } });
  const decide = async () => ({ event: { type: "REPLY" as const } });

  const first = await runAgent(jsonAgentMachine, {
    input: { ticket: "My invoice total looks wrong." },
    executors: { generateText, decide },
  });

  expect(first.status).toBe("idle");

  const second = await runAgent(jsonAgentMachine, {
    snapshot: first.status === "idle" ? first.snapshot : undefined,
    event: { type: "APPROVE" },
    executors: { generateText, decide },
  });

  expect(second.status).toBe("done");
  expect(second.status === "done" && second.output).toEqual({
    resolution: "replied",
    reply: "Sorry about that — refund issued.",
  });
});

test("ESCALATE path: decide escalates directly, no reply drafted", async () => {
  const generateText = async () => {
    throw new Error("draftReply should not run on the escalate path");
  };
  const decide = async () => ({ event: { type: "ESCALATE" as const, reason: "angry customer" } });

  const result = await runAgent(jsonAgentMachine, {
    input: { ticket: "This is unacceptable, get me a manager." },
    executors: { generateText, decide },
  });

  expect(result.status).toBe("done");
  expect(result.status === "done" && result.output).toEqual({ resolution: "escalated" });
});
