import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import type { AgentTool } from "@statelyai/agent";
import { BOOKINGS, customerSupportMachine, runCustomerSupportExample } from "./index.js";

// Mock host: routes on `request.name` (the setupAgent request key). The
// `classify` request returns a scripted intent; the `answer` request plays the
// adapter's tool loop — picks the named tool, runs its REAL logic, formats the
// result. Only the model call is mocked.
function executeTool(tool: AgentTool | undefined, input: unknown) {
  return typeof tool === "function" ? tool(input) : tool?.execute?.(input);
}

interface MockScript {
  intent: unknown;
  answerTool?: { name: string; input: unknown };
}

function mockGenerateText(script: MockScript) {
  return async (request: { name?: string; tools?: Record<string, AgentTool | undefined> }) => {
    if (request.name === "classify") {
      return { output: script.intent };
    }
    // answer request: run the requested read-only tool, then answer with it.
    const call = script.answerTool!;
    const result = await executeTool(request.tools?.[call.name], call.input);
    return { output: `Answer: ${JSON.stringify(result)}` };
  };
}

test("direct-answer path: classify → answer runs a real read-only tool, done in one call", async () => {
  const result = await runCustomerSupportExample({
    query: "What's the baggage policy?",
    generateText: mockGenerateText({
      intent: { intent: "question" },
      answerTool: { name: "searchPolicies", input: { topic: "baggage" } },
    }),
  });

  expect(result.settledIdle).toBe(false);
  expect(result.resolution).toBe("answered");
  // Real tool logic ran against the sample POLICIES table.
  expect(result.message).toContain("Checked bags are $40 each");
  // One invoking path, no confirmation gate.
  expect(result.progress).toContain("answering");
  expect(result.progress).not.toContain("confirming");
  expect(result.progress.at(-1)).toBe("answered");
});

test("lookupBooking tool reads the sample booking table", async () => {
  const result = await runCustomerSupportExample({
    query: "What's my flight for AB1234?",
    generateText: mockGenerateText({
      intent: { intent: "question" },
      answerTool: { name: "lookupBooking", input: { confirmationCode: "AB1234" } },
    }),
  });

  expect(result.message).toContain("Ada Lovelace");
  expect(result.message).toContain("BA249");
});

test("sensitive path settles idle with the pending action, label, and legal events", async () => {
  const result = await runCustomerSupportExample({
    query: "Please cancel my booking AB1234.",
    generateText: mockGenerateText({
      intent: { intent: "cancel", confirmationCode: "AB1234" },
    }),
    // approve so the whole round-trip runs, but assert the idle-phase details.
    approve: true,
  });

  expect(result.settledIdle).toBe(true);
  // The machine paused at `confirming` — an explicit state, not a host-side flag.
  expect(result.progress).toContain("confirming");
  // Legal events come from the idle snapshot, not a hand-maintained list.
  expect(result.legalEvents).toEqual(expect.arrayContaining(["APPROVE", "DENY"]));
  // Static label from meta.interaction; dynamic specifics from context.
  expect(result.interactionLabel).toContain("needs your approval");
  expect(result.pendingAction).toMatchObject({
    type: "cancel",
    confirmationCode: "AB1234",
    summary: "Cancel booking AB1234",
  });
});

test("APPROVE resumes from the persisted snapshot and executes the action", async () => {
  const result = await runCustomerSupportExample({
    query: "Please cancel my booking AB1234.",
    approve: true,
    generateText: mockGenerateText({
      intent: { intent: "cancel", confirmationCode: "AB1234" },
    }),
  });

  expect(result.resolution).toBe("executed");
  expect(result.progress).toContain("executing");
  expect(result.progress.at(-1)).toBe("executed");
  // The executeAction actor read the real booking and produced the confirmation.
  expect(result.message).toContain("AB1234");
  expect(result.message).toContain("cancelled");
});

test("the advertised cancel starter approves onto a real booking", async () => {
  const starters = JSON.parse(readFileSync(new URL("./metadata.json", import.meta.url), "utf8"))
    .starters as string[];
  const cancelStarter = starters.find((starter) => /cancel/i.test(starter))!;
  const code = cancelStarter.match(/\b[A-Z0-9]{5,6}\b/)![0];
  // The starter's confirmation code must exist in the sample table, or approving
  // returns "No booking found; nothing changed."
  expect(BOOKINGS[code]).toBeDefined();

  const result = await runCustomerSupportExample({
    query: cancelStarter,
    approve: true,
    generateText: mockGenerateText({ intent: { intent: "cancel", confirmationCode: code } }),
  });

  expect(result.resolution).toBe("executed");
  expect(result.message).toContain("cancelled");
  expect(result.message).not.toContain("No booking found");
});

test("rebook APPROVE carries the new flight through to execution", async () => {
  const result = await runCustomerSupportExample({
    query: "Move CD5678 to the morning flight.",
    approve: true,
    generateText: mockGenerateText({
      intent: {
        intent: "rebook",
        confirmationCode: "CD5678",
        newFlight: "AA106 JFK→LHR, 2026-09-14 09:00",
      },
    }),
  });

  expect(result.resolution).toBe("executed");
  expect(result.pendingAction).toMatchObject({
    type: "rebook",
    newFlight: "AA106 JFK→LHR, 2026-09-14 09:00",
  });
  expect(result.message).toContain("AA106");
  expect(result.message).toContain("$75 change fee");
});

test("DENY resumes and skips the action, capturing the reason", async () => {
  const result = await runCustomerSupportExample({
    query: "Please cancel my booking AB1234.",
    approve: false,
    denyReason: "Actually I still need the flight.",
    generateText: mockGenerateText({
      intent: { intent: "cancel", confirmationCode: "AB1234" },
    }),
  });

  expect(result.resolution).toBe("denied");
  // Never entered the executing state — the booking is untouched.
  expect(result.progress).not.toContain("executing");
  expect(result.progress.at(-1)).toBe("denied");
  expect(result.message).toContain("Actually I still need the flight.");
});

test("machine exports a runnable definition", () => {
  expect(customerSupportMachine.id).toBe("customer-support");
});
