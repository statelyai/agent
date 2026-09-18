import { expect, test } from "vitest";
import type { Snapshot } from "xstate";
import { resumeScenarioRun, startScenarioRun } from "./agent-runner";
import { cases, runCase, runComparison } from "./email-drafter-compare";
import { scriptedExecutorsFor } from "./scripted-executors";
import { emailDrafterV1Machine } from "@/agents/email-drafter-v1";
import { emailDrafterV2Machine } from "@/agents/email-drafter-v2";

// The scripted executors the UI runs without a key; same for both versions.
const executors = scriptedExecutorsFor("email-drafter-v1");

const optionalCase = cases.find((entry) => entry.id === "optional-1")!;
const recipientCase = cases.find((entry) => entry.id === "recipient-1")!;

test("v1 asks before drafting when only optional details are missing; v2 drafts first", async () => {
  const v1 = await runCase(emailDrafterV1Machine, optionalCase, executors);
  const v2 = await runCase(emailDrafterV2Machine, optionalCase, executors);

  expect(v1.clarificationTurns).toBeGreaterThan(0);
  expect(v1.path).toContain("needsMoreInfo");
  expect(v1.clarifications).toContain("What is the subject?");
  expect(v2.clarificationTurns).toBe(0);
  // v2 still surfaces the gap; it just does not block on it.
  expect(v2.clarifications).toEqual(["What subject line do you want?"]);
  expect(v2.path).toEqual(["drafting", "reviewing", "sending", "sent"]);
  expect(v1.sent && v2.sent).toBe(true);
});

test("v2 moves the recipient check to the send boundary and never sends without one", async () => {
  const start = (id: "email-drafter-v2", prompt: string) =>
    startScenarioRun(id, prompt, "script", undefined, executors);
  const resume = (snapshot: unknown, event: { type: string; [key: string]: unknown }) =>
    resumeScenarioRun(
      "email-drafter-v2",
      snapshot as Snapshot<unknown>,
      event,
      "script",
      undefined,
      executors,
    );

  const reviewing = await start("email-drafter-v2", recipientCase.prompt);
  expect(reviewing.status).toBe("idle");
  expect(reviewing.response).toContain("**Open questions**\n- Who should this go to?");
  expect(reviewing.idle?.events.map((event) => event.type)).toEqual(["REQUEST_CHANGES", "SEND"]);
  expect(reviewing.idle?.textEvent).toEqual({ type: "REQUEST_CHANGES", field: "text" });
  expect(reviewing.response).toContain("(no recipient yet)");

  // SEND with no recipient: the workflow asks instead of sending.
  const asked = await resume(reviewing.idle!.snapshot, { type: "SEND" });
  expect(asked.status).toBe("idle");
  expect(asked.idle?.prompt).toContain("Who should this go to?");
  expect(asked.idle?.textEvent).toEqual({ type: "RECIPIENT_PROVIDED", field: "text" });

  // An invalid address keeps asking, and says what was wrong with it.
  const stillAsking = await resume(asked.idle!.snapshot, {
    type: "RECIPIENT_PROVIDED",
    text: "Alex",
  });
  expect(stillAsking.status).toBe("idle");
  expect(stillAsking.idle?.prompt).toContain('"Alex" is not an email address');
  expect(stillAsking.idle?.prompt).toContain("Who should this go to?");
  // The draft keeps its empty recipient; the bad address is only quoted back.
  expect(stillAsking.response).toContain("(no recipient yet)");

  // A valid one sends, because the human already chose SEND.
  const sent = await resume(stillAsking.idle!.snapshot, {
    type: "RECIPIENT_PROVIDED",
    text: "alex@example.com",
  });
  expect(sent.status).toBe("done");
  expect(sent.response).toContain("Sent (simulated outbox)");
  expect(sent.response).toContain("alex@example.com");
});

test("v1 'draft anyway' cannot send without a recipient; SEND asks instead", async () => {
  const resume = (snapshot: unknown, event: { type: string; [key: string]: unknown }) =>
    resumeScenarioRun(
      "email-drafter-v1",
      snapshot as Snapshot<unknown>,
      event,
      "script",
      undefined,
      executors,
    );
  const asked = await startScenarioRun(
    "email-drafter-v1",
    recipientCase.prompt,
    "script",
    undefined,
    executors,
  );
  const reviewing = await resume(asked.idle!.snapshot, { type: "DRAFT_ANYWAY" });
  expect(reviewing.status).toBe("idle");
  expect(reviewing.response).toContain("(no recipient yet)");

  const askedAgain = await resume(reviewing.idle!.snapshot, { type: "SEND" });
  expect(askedAgain.status).toBe("idle");
  expect(askedAgain.idle?.prompt).toContain("Who should this go to?");
  expect(askedAgain.idle?.events.map((event) => event.type)).toEqual(["MORE_INFO", "DRAFT_ANYWAY"]);

  // MORE_INFO re-evaluates and re-drafts; the scripted drafter picks the address up.
  const redrafted = await resume(askedAgain.idle!.snapshot, {
    type: "MORE_INFO",
    text: "Recipient: alex@example.com. Subject: Coffee on Thursday.",
  });
  expect(redrafted.status).toBe("idle");
  const done = await resume(redrafted.idle!.snapshot, { type: "SEND" });
  expect(done.status).toBe("done");
  expect(done.response).toContain("alex@example.com");
});

test("scripted mode reads an angle-bracketed address, so v2 sends without asking", async () => {
  const reviewing = await startScenarioRun(
    "email-drafter-v2",
    "Email <priya@example.com>, subject 'Hi', saying the deck is ready.",
    "script",
    undefined,
    executors,
  );
  expect(reviewing.status).toBe("idle");
  expect(reviewing.response).toContain("**To:** priya@example.com");
  const sent = await resumeScenarioRun(
    "email-drafter-v2",
    reviewing.idle!.snapshot as unknown as Snapshot<unknown>,
    { type: "SEND" },
    "script",
    undefined,
    executors,
  );
  expect(sent.status).toBe("done");
});

test("a request that errors still counts as a model call, with no token total", async () => {
  const run = await runCase(emailDrafterV2Machine, optionalCase, {
    generateText: async () => {
      throw new Error("model offline");
    },
  });
  expect(run.modelCalls).toBe(1);
  expect(run.totalTokens).toBeNull();
  expect(run.failure).toMatch(/draftEmail failed/);
  expect(run.sent).toBe(false);
});

test("hasRecipient rejects malformed and multi-address values", async () => {
  const { hasRecipient } = await import("@/agents/email-draft");
  const draft = (to: string) => ({ to, subject: "s", body: "b" });
  expect(hasRecipient(draft("alex@example.com"))).toBe(true);
  expect(hasRecipient(draft("alex@example.com,other"))).toBe(false);
  expect(hasRecipient(draft("Alex"))).toBe(false);
  expect(hasRecipient(draft(""))).toBe(false);
  expect(hasRecipient(null)).toBe(false);
});

test("v1 idle label surfaces the evaluator's questions", async () => {
  const first = await startScenarioRun(
    "email-drafter-v1",
    recipientCase.prompt,
    "script",
    undefined,
    executors,
  );
  expect(first.status).toBe("idle");
  expect(first.idle?.prompt).toContain("What is the recipient?");
  expect(first.idle?.events.map((event) => event.type)).toEqual(["MORE_INFO", "DRAFT_ANYWAY"]);
});

test("the comparison holds the send rule for both versions and v2 asks less", async () => {
  const [v1, v2] = await runComparison(executors);
  expect(v1?.machine).toBe("v1");
  expect(v2?.machine).toBe("v2");

  for (const summary of [v1!, v2!]) {
    // Scripted executors report no usage, so no total is claimed.
    expect(summary.totals.totalTokens).toBeNull();
    expect(summary.totals.sendRuleViolations).toBe(0);
    expect(summary.totals.sent).toBe(cases.length);
    expect(summary.runs.every((run) => run.failure === null)).toBe(true);
  }
  expect(v2!.totals.clarificationTurns).toBeLessThan(v1!.totals.clarificationTurns);
  expect(v2!.totals.modelCalls).toBeLessThan(v1!.totals.modelCalls);

  // The weighted graph: v1's clarification loop shows up as traversed edges;
  // v2 has no such edges to traverse.
  expect(Object.keys(v1!.edges).some((edge) => edge.includes("--> needsMoreInfo"))).toBe(true);
  expect(Object.keys(v2!.edges).some((edge) => edge.includes("needsMoreInfo"))).toBe(false);
  // Missing-recipient cases still get asked in v2, at the boundary.
  expect(v2!.byCategory["missing-recipient"]?.clarificationTurns).toBe(2);
  expect(v2!.byCategory["missing-optional"]?.clarificationTurns).toBe(0);
});

test("v2 offers 'Add subject' in SEND's place, and sending stays a separate decision", async () => {
  const resume = (snapshot: unknown, event: { type: string; [key: string]: unknown }) =>
    resumeScenarioRun(
      "email-drafter-v2",
      snapshot as Snapshot<unknown>,
      event,
      "script",
      undefined,
      executors,
    );

  const reviewing = await startScenarioRun(
    "email-drafter-v2",
    "Email jenny@example.com about coffee after my talk on Thursday, no subject line.",
    "script",
    undefined,
    executors,
  );
  expect(reviewing.status).toBe("idle");
  expect(reviewing.response).toContain("(no subject yet)");
  // SEND would not send, so it is not offered.
  expect(reviewing.idle?.events.map((event) => event.type)).toEqual([
    "REQUEST_CHANGES",
    "ADD_SUBJECT",
  ]);
  expect(reviewing.idle?.prompt).toContain("no subject line yet");

  const asking = await resume(reviewing.idle!.snapshot, { type: "ADD_SUBJECT" });
  expect(asking.idle?.prompt).toContain("What should the subject line be?");
  expect(asking.idle?.textEvent).toEqual({ type: "SUBJECT_PROVIDED", field: "text" });

  // Blank text keeps asking; asking costs no model call and no revision.
  const stillAsking = await resume(asking.idle!.snapshot, { type: "SUBJECT_PROVIDED", text: "  " });
  expect(stillAsking.idle?.prompt).toContain("What should the subject line be?");

  // A subject returns to the same review, where SEND is back on offer.
  const back = await resume(stillAsking.idle!.snapshot, {
    type: "SUBJECT_PROVIDED",
    text: "Coffee Thursday?",
  });
  expect(back.response).toContain("**Subject:** Coffee Thursday?");
  expect(back.idle?.events.map((event) => event.type)).toEqual(["REQUEST_CHANGES", "SEND"]);

  const sent = await resume(back.idle!.snapshot, { type: "SEND" });
  expect(sent.status).toBe("done");
  expect(sent.response).toContain("Coffee Thursday?");
});

test("a sent email drops the open questions; a draft still shows them", async () => {
  const reviewing = await startScenarioRun(
    "email-drafter-v2",
    optionalCase.prompt,
    "script",
    undefined,
    executors,
  );
  expect(reviewing.response).toContain("**Open questions**");

  const sent = await resumeScenarioRun(
    "email-drafter-v2",
    reviewing.idle!.snapshot as unknown as Snapshot<unknown>,
    { type: "SEND" },
    "script",
    undefined,
    executors,
  );
  expect(sent.status).toBe("done");
  // The questions are still in the output; they just do not trail the email.
  expect((sent.output as { clarifications: string[] }).clarifications.length).toBeGreaterThan(0);
  expect(sent.response).not.toContain("Open questions");
});

test("v1 SEND with no subject asks, the same way it asks for a recipient", async () => {
  const resume = (snapshot: unknown, event: { type: string; [key: string]: unknown }) =>
    resumeScenarioRun(
      "email-drafter-v1",
      snapshot as Snapshot<unknown>,
      event,
      "script",
      undefined,
      executors,
    );
  const reviewing = await startScenarioRun(
    "email-drafter-v1",
    "Email jenny@example.com about coffee after my talk on Thursday, no subject line.",
    "script",
    undefined,
    executors,
  );
  expect(reviewing.status).toBe("idle");
  expect(reviewing.response).toContain("(no subject yet)");

  const asked = await resume(reviewing.idle!.snapshot, { type: "SEND" });
  expect(asked.idle?.prompt).toContain("What should the subject line be?");
  expect(asked.idle?.events.map((event) => event.type)).toEqual(["MORE_INFO", "DRAFT_ANYWAY"]);
});
