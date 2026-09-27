import { readFileSync } from "node:fs";
import { beforeEach, expect, test } from "vitest";
import type { AgentTool } from "@statelyai/agent";
import { createMockJudge } from "../mock-judge.js";
import {
  BOOKINGS,
  customerSupportMachine,
  findCodeCandidates,
  MAX_CLARIFICATIONS,
  resetBookings,
  runCustomerSupportExample,
} from "./index.js";

// `executeAction` writes to BOOKINGS, so each test starts from the fixture.
beforeEach(resetBookings);

// Mock host: the `answer` request plays the adapter's tool loop — picks the
// named tool, runs its REAL logic, formats the result. `classify` is a judge
// call, scripted by question name (`intent`, `newFlight`, `confirmationCode`)
// through a mock judge that implements the AI SDK's evaluation-model spec; the
// candidate pre-parsing runs for real.
function executeTool(tool: AgentTool | undefined, input: unknown) {
  return typeof tool === "function" ? tool(input) : tool?.execute?.(input);
}

interface MockScript {
  answerTool?: { name: string; input: unknown };
  /** Questions the answer request asks before it answers, in order. */
  asks?: string[];
}

function mockGenerateText(script: MockScript) {
  let asked = 0;
  return async (request: { name?: string; tools?: Record<string, AgentTool | undefined> }) => {
    // The answer request now reports whether it actually answered.
    const ask = script.asks?.[asked];
    if (ask !== undefined) {
      asked += 1;
      return { result: { status: "needsInfo", question: ask } };
    }
    // answer request: run the requested read-only tool, then answer with it.
    const call = script.answerTool!;
    const result = await executeTool(request.tools?.[call.name], call.input);
    return { result: { status: "answered", answer: `Answer: ${JSON.stringify(result)}` } };
  };
}

/**
 * The classifier's judge answers. `newFlight` is always asked (default `none`);
 * `confirmationCode` only when the message holds 2+ candidate codes.
 */
function classifier(answers: { intent: string; newFlight?: string; confirmationCode?: string }) {
  return createMockJudge({
    newFlight: "none",
    ...answers,
  });
}

test("direct-answer path: classify → answer runs a real read-only tool, done in one call", async () => {
  const result = await runCustomerSupportExample({
    query: "What's the baggage policy?",
    generateText: mockGenerateText({
      answerTool: { name: "searchPolicies", input: { topic: "baggage" } },
    }),
    judge: classifier({ intent: "question" }).model,
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
      answerTool: { name: "lookupBooking", input: { confirmationCode: "AB1234" } },
    }),
    judge: classifier({ intent: "question" }).model,
  });

  expect(result.message).toContain("Ada Lovelace");
  expect(result.message).toContain("BA249");
});

test("a question it cannot answer alone pauses for the detail instead of ending", async () => {
  const result = await runCustomerSupportExample({
    query: "What's the carry-on baggage allowance on my ticket?",
    replies: ["AB1234"],
    generateText: mockGenerateText({
      asks: ["Which booking is this? Please send your confirmation code."],
      answerTool: { name: "lookupBooking", input: { confirmationCode: "AB1234" } },
    }),
    judge: classifier({ intent: "question" }).model,
  });

  // The old machine reported `answered` here having answered nothing.
  expect(result.resolution).toBe("answered");
  expect(result.message).toContain("Ada Lovelace");
  // The pause is a state, and the customer's reply drove a second attempt.
  expect(result.progress).toContain("awaitingInfo");
  expect(result.progress.filter((state) => state === "answering")).toHaveLength(2);
});

test("declining to answer ends the turn unresolved, not answered", async () => {
  const result = await runCustomerSupportExample({
    query: "What's the carry-on baggage allowance on my ticket?",
    replies: [], // the customer says nothing, so the host sends STOP_ASKING
    generateText: mockGenerateText({
      asks: ["Which booking is this?"],
    }),
    judge: classifier({ intent: "question" }).model,
  });

  expect(result.resolution).toBe("unresolved");
  expect(result.progress.at(-1)).toBe("unresolved");
});

test("the machine stops asking once its clarification budget is spent", async () => {
  const asks = Array.from({ length: MAX_CLARIFICATIONS + 1 }, (_, i) => `Question ${i + 1}?`);
  const result = await runCustomerSupportExample({
    query: "What's my allowance?",
    // Always willing to answer: the bound has to come from the machine.
    replies: asks.map((_, index) => `reply ${index + 1}`),
    generateText: mockGenerateText({ asks }),
    judge: classifier({ intent: "question" }).model,
  });

  expect(result.resolution).toBe("unresolved");
  // One attempt to answer, then one more per clarification it was allowed to
  // ask for — and then it stops, however willing the customer still is.
  expect(result.progress.filter((state) => state === "answering")).toHaveLength(
    MAX_CLARIFICATIONS + 1,
  );
});

test("sensitive path settles idle with the pending action, label, and legal events", async () => {
  const result = await runCustomerSupportExample({
    query: "Please cancel my booking AB1234.",
    generateText: mockGenerateText({}),
    judge: classifier({ intent: "cancel" }).model,
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
    generateText: mockGenerateText({}),
    judge: classifier({ intent: "cancel" }).model,
  });

  expect(result.resolution).toBe("executed");
  expect(result.progress).toContain("executing");
  expect(result.progress.at(-1)).toBe("executed");
  // The executeAction actor read the real booking and produced the confirmation.
  expect(result.message).toContain("AB1234");
  expect(result.message).toContain("cancelled");
  // ...and it actually wrote the change: the booking is cancelled in the table.
  expect(BOOKINGS.AB1234?.status).toBe("cancelled");
});

test("an unknown confirmation code fails the turn instead of reporting a change", async () => {
  const result = await runCustomerSupportExample({
    query: "Please cancel my booking ZZ9999.",
    approve: true,
    generateText: mockGenerateText({}),
    judge: classifier({ intent: "cancel" }).model,
  });

  expect(result.resolution).toBe("failed");
  expect(result.progress.at(-1)).toBe("failed");
  expect(result.message).toContain("No booking found");
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
    generateText: mockGenerateText({}),
    judge: classifier({ intent: "cancel" }).model,
  });

  expect(result.resolution).toBe("executed");
  expect(result.message).toContain("cancelled");
  expect(result.message).not.toContain("No booking found");
});

test("rebook APPROVE carries the new flight through to execution", async () => {
  const result = await runCustomerSupportExample({
    query: "Move CD5678 to the morning flight.",
    approve: true,
    generateText: mockGenerateText({}),
    // "the morning flight" resolves by SELECTION among CD5678's route alternatives.
    judge: classifier({ intent: "rebook", newFlight: "AA106" }).model,
  });

  expect(result.resolution).toBe("executed");
  expect(result.pendingAction).toMatchObject({
    type: "rebook",
    newFlight: "AA106 JFK→LHR, 2026-09-14 09:00",
  });
  expect(result.message).toContain("AA106");
  expect(result.message).toContain("$75 change fee");
  // The rebook was written through to the table, not just described.
  expect(BOOKINGS.CD5678?.flight).toBe("AA106 JFK→LHR, 2026-09-14 09:00");
});

test("DENY resumes and skips the action, capturing the reason", async () => {
  const result = await runCustomerSupportExample({
    query: "Please cancel my booking AB1234.",
    approve: false,
    denyReason: "Actually I still need the flight.",
    generateText: mockGenerateText({}),
    judge: classifier({ intent: "cancel" }).model,
  });

  expect(result.resolution).toBe("denied");
  // Never entered the executing state — the booking is untouched.
  expect(result.progress).not.toContain("executing");
  expect(result.progress.at(-1)).toBe("denied");
  expect(result.message).toContain("Actually I still need the flight.");
  // The booking is genuinely untouched.
  expect(BOOKINGS.AB1234?.status).toBe("confirmed");
});

test("classify is one Jev call: intent and newFlight choices over the pre-parsed candidates", async () => {
  const jev = classifier({ intent: "rebook", newFlight: "AA106" });
  await runCustomerSupportExample({
    query: "Move CD5678 to the morning flight.",
    approve: false,
    generateText: mockGenerateText({}),
    judge: jev.model,
  });

  expect(jev.calls).toHaveLength(1);
  const call = jev.calls[0]!;
  const state = call.state as { message: string; knownCodes: string[]; flights: { id: string }[] };
  expect(state.message).toBe("Move CD5678 to the morning flight.");
  // One candidate code: code takes it, so no confirmationCode question.
  expect(state.knownCodes).toEqual(["CD5678"]);
  // Only CD5678's route (JFK→LHR) alternatives are offered.
  expect(state.flights.map((flight) => flight.id)).toEqual(["AA106", "AA104"]);
  expect(Object.keys(call.questions)).toEqual(["intent", "newFlight"]);
  const questions = call.questions as Record<string, { type: string; criteria: object }>;
  expect(Object.values(questions).every((question) => question.type === "choice")).toBe(true);
  expect(Object.keys(questions.intent!.criteria)).toEqual(["question", "cancel", "rebook"]);
  expect(Object.keys(questions.newFlight!.criteria)).toEqual(["AA106", "AA104", "none"]);
});

test("two candidate codes: Jev picks which span is the confirmation code", async () => {
  const query = "Move CD5678 onto AA106 please.";
  expect(findCodeCandidates(query)).toEqual(["CD5678", "AA106"]);
  const jev = classifier({ intent: "rebook", newFlight: "AA106", confirmationCode: "CD5678" });
  const result = await runCustomerSupportExample({
    query,
    approve: false,
    generateText: mockGenerateText({}),
    judge: jev.model,
  });

  const question = jev.calls[0]!.questions.confirmationCode as { type: string; criteria: object };
  expect(question.type).toBe("choice");
  expect(Object.keys(question.criteria)).toEqual(["CD5678", "AA106", "none"]);
  expect(result.pendingAction).toMatchObject({ type: "rebook", confirmationCode: "CD5678" });
});

test("a sensitive intent without a code or a target flight fails before the approval gate", async () => {
  const noCode = await runCustomerSupportExample({
    query: "Please cancel my flight.",
    generateText: mockGenerateText({}),
    judge: classifier({ intent: "cancel" }).model,
  });
  expect(noCode.resolution).toBe("failed");
  expect(noCode.message).toContain("confirmation code");
  expect(noCode.progress).not.toContain("confirming");

  const noFlight = await runCustomerSupportExample({
    query: "Move CD5678 to a better flight.",
    generateText: mockGenerateText({}),
    judge: classifier({ intent: "rebook", newFlight: "none" }).model,
  });
  expect(noFlight.resolution).toBe("failed");
  expect(noFlight.message).toContain("which scheduled flight");
  expect(BOOKINGS.CD5678?.flight).toBe("AA100 JFK→LHR, 2026-09-14 18:15");
});

test("machine exports a runnable definition", () => {
  expect(customerSupportMachine.id).toBe("customer-support");
});
