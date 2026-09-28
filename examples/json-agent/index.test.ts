import { readFileSync } from "node:fs";
import { assert, expect, test } from "vitest";
import {
  getInteraction,
  createAgentRuntime,
  runToQuiescence,
  type AgentDecisionRequest,
} from "@statelyai/agent";
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
  const generateText = async () => ({ result: { reply: "Sorry about that — refund issued." } });
  const decide = async () => ({ event: { type: "REPLY" as const } });

  const first = await runToQuiescence(
    createAgentRuntime(jsonAgentMachine, {
      executors: { generateText, decide },
    }),
    {
      input: { ticket: "My invoice total looks wrong." },
    },
  );

  assert(first.status === "idle");
  expect(first.snapshot.matches("awaitingApproval")).toBe(true);
  // The idle state advertises both human moves through `meta.interaction`.
  expect(getInteraction(first.snapshot)?.events.map((choice) => choice.type)).toEqual([
    "APPROVE",
    "REJECT",
  ]);

  const second = await runToQuiescence(
    createAgentRuntime(jsonAgentMachine, {
      executors: { generateText, decide },
    }),
    {
      snapshot: first.snapshot,
      event: { type: "APPROVE" },
    },
  );

  assert(second.status === "done");
  // The draft was shown at approval; the output is the outcome, not a repeat.
  expect(second.output).toEqual({ resolution: "replied" });
  expect(second.snapshot.context.reply).toBe("Sorry about that — refund issued.");
});

test("REJECT path: rejecting the draft escalates and keeps the drafted reply", async () => {
  const generateText = async () => ({ result: { reply: "Here is a workaround." } });
  const decide = async () => ({ event: { type: "REPLY" as const } });

  const first = await runToQuiescence(
    createAgentRuntime(jsonAgentMachine, {
      executors: { generateText, decide },
    }),
    {
      input: { ticket: "Third time this has broken." },
    },
  );

  assert(first.status === "idle");

  const second = await runToQuiescence(
    createAgentRuntime(jsonAgentMachine, {
      executors: { generateText, decide },
    }),
    {
      snapshot: first.snapshot,
      event: { type: "REJECT" },
    },
  );

  assert(second.status === "done");
  expect(second.output).toEqual({
    resolution: "escalated",
    escalationReason: "Reviewer rejected the drafted reply.",
    reply: "Here is a workaround.",
  });
});

test("the decision prompt splits the starters: login trouble drafts a reply, a duplicate charge escalates", async () => {
  // QA regression: the old one-line prompt escalated both starters, so the
  // demo never reached the draft → approve wait. The prompt now makes REPLY
  // the default (a human approves every draft anyway) and reserves ESCALATE
  // for money or account actions.
  const starters = (
    JSON.parse(readFileSync(new URL("./metadata.json", import.meta.url), "utf8")).starters as {
      input: { ticket: string };
    }[]
  ).map((starter) => starter.input.ticket);
  const login = starters.find((ticket) => /log in/.test(ticket));
  const duplicate = starters.find((ticket) => /charged me twice/.test(ticket));
  assert(login && duplicate);

  const seen: AgentDecisionRequest[] = [];
  // Stands in for the model reading the system prompt: it follows the rule
  // the prompt states, keyed on the ticket.
  const decide = async (request: AgentDecisionRequest) => {
    seen.push(request);
    return request.prompt?.includes("twice")
      ? { event: { type: "ESCALATE" as const, reason: "duplicate charge needs a refund" } }
      : { event: { type: "REPLY" as const } };
  };
  const generateText = async () => ({ result: { reply: "Check your spam folder." } });

  const replied = await runToQuiescence(
    createAgentRuntime(jsonAgentMachine, { executors: { generateText, decide } }),
    { input: { ticket: login } },
  );
  assert(replied.status === "idle");
  expect(replied.snapshot.matches("awaitingApproval")).toBe(true);

  const escalated = await runToQuiescence(
    createAgentRuntime(jsonAgentMachine, { executors: { generateText: noDraft, decide } }),
    { input: { ticket: duplicate } },
  );
  assert(escalated.status === "done");
  expect(escalated.output.resolution).toBe("escalated");

  expect(seen[0]!.system).toContain("REPLY is the default");
  expect(seen[0]!.system).toContain("duplicate or disputed charges");
});

test("ESCALATE path: the decision escalates directly, with no reply drafted", async () => {
  const decide = async () => ({ event: { type: "ESCALATE" as const, reason: "angry customer" } });

  const result = await runToQuiescence(
    createAgentRuntime(jsonAgentMachine, {
      executors: { generateText: noDraft, decide },
    }),
    {
      input: { ticket: "This is unacceptable, get me a manager." },
    },
  );

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

  const result = await runToQuiescence(
    createAgentRuntime(jsonAgentMachine, {
      executors: { generateText: noDraft, decide },
    }),
    {
      input: { ticket: "Where is my order?" },
    },
  );

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

  const result = await runToQuiescence(
    createAgentRuntime(jsonAgentMachine, {
      executors: { generateText, decide },
    }),
    {
      input: { ticket: "My invoice total looks wrong." },
    },
  );

  assert(result.status === "done");
  expect(result.output).toEqual({
    resolution: "failed",
    error: expect.stringContaining("Drafting the reply failed: "),
  });
});
