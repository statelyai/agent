import { expect, test } from "vitest";
import {
  eventFromInteraction,
  getInteraction,
  runAgent,
  type AgentRequestExecutors,
} from "@statelyai/agent";
import { MAX_REVISIONS, emailDrafter } from "./agent-logic.js";

/** Routes on the request's declared name, never on prompt text. */
const executors = {
  generateText: async ({ name }) =>
    name === "evaluatePrompt"
      ? { output: { satisfied: true, missing: [], questions: [] } }
      : {
          output: {
            to: "team@example.com",
            subject: "Deploy pipeline is faster",
            body: "Hi team, deploys are twice as fast now.",
          },
        },
} satisfies Partial<AgentRequestExecutors>;

/** Start the machine and deliver the opening request as free text. */
async function openAtReview() {
  const opened = await runAgent(emailDrafter, { input: undefined, executors });
  if (opened.status !== "idle") throw new Error(`Expected idle, got ${opened.status}`);
  return runAgent(emailDrafter, {
    snapshot: opened.snapshot,
    event: eventFromInteraction(opened.snapshot, { text: "Tell the team deploys are faster." }),
    executors,
  });
}

test("the reviewing pause renders both choices and routes free text to REQUEST_CHANGES", async () => {
  const result = await openAtReview();
  expect(result.status).toBe("idle");
  if (result.status !== "idle") return;

  const interaction = getInteraction(result.snapshot);
  expect(interaction?.label).toContain("Send the draft");
  expect(interaction?.events.map(({ type }) => type)).toEqual(["SEND", "REQUEST_CHANGES"]);
  expect(interaction?.textEvent).toBe("REQUEST_CHANGES");
});

test("the revision budget stops rendering REQUEST_CHANGES once it is spent", async () => {
  let result = await openAtReview();

  for (let revision = 0; revision < MAX_REVISIONS; revision++) {
    if (result.status !== "idle") throw new Error(`Expected idle, got ${result.status}`);
    expect(getInteraction(result.snapshot)?.textEvent).toBe("REQUEST_CHANGES");
    result = await runAgent(emailDrafter, {
      snapshot: result.snapshot,
      event: eventFromInteraction(result.snapshot, { text: "Shorter, please." }),
      executors,
    });
  }

  if (result.status !== "idle") throw new Error(`Expected idle, got ${result.status}`);
  // The budget is spent, so drafting landed in `finalReview` instead — a state
  // that does not accept REQUEST_CHANGES at all. SEND is all that is left.
  expect(result.snapshot.matches("finalReview")).toBe(true);
  const interaction = getInteraction(result.snapshot);
  expect(interaction?.events.map(({ type }) => type)).toEqual(["SEND"]);
  expect(interaction?.textEvent).toBeUndefined();
});

test("a failed request ends in `failed`, with the reason in the output", async () => {
  const opened = await runAgent(emailDrafter, { input: undefined, executors });
  if (opened.status !== "idle") throw new Error(`Expected idle, got ${opened.status}`);

  const result = await runAgent(emailDrafter, {
    snapshot: opened.snapshot,
    event: eventFromInteraction(opened.snapshot, { text: "Anything." }),
    executors: {
      generateText: async () => {
        throw new Error("model offline");
      },
    },
  });

  expect(result.status).toBe("done");
  if (result.status !== "done") return;
  expect(result.output.sentEmails).toEqual([]);
  expect(result.output.failure).toMatch(/evaluatePrompt failed/);
});

test("SEND then END finishes with the sent email and no failure", async () => {
  const reviewing = await openAtReview();
  if (reviewing.status !== "idle") throw new Error("expected the review pause");

  const sent = await runAgent(emailDrafter, {
    snapshot: reviewing.snapshot,
    event: eventFromInteraction(reviewing.snapshot, { type: "SEND" }),
    executors,
  });
  if (sent.status !== "idle") throw new Error("expected the 'draft another?' pause");

  const done = await runAgent(emailDrafter, {
    snapshot: sent.snapshot,
    event: eventFromInteraction(sent.snapshot, { type: "END" }),
    executors,
  });

  expect(done.status).toBe("done");
  if (done.status !== "done") return;
  expect(done.output.sentEmails).toHaveLength(1);
  expect(done.output.sentEmails[0]?.to).toBe("team@example.com");
  expect(done.output.failure).toBeNull();
});
