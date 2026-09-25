import { expect, test } from "vitest";
import {
  eventFromInteraction,
  getInteraction,
  runAgent,
  type AgentRequestExecutors,
} from "@statelyai/agent";
import { createMockJudge } from "../mock-judge.js";
import {
  ASSESSMENT_THRESHOLD,
  MAX_REVISIONS,
  REQUIRED_DETAILS,
  createEvaluatePrompt,
  emailDrafter,
} from "./agent-logic.js";

/** Routes on the request's declared name, never on prompt text. */
const executors = {
  generateText: async ({ name }) =>
    name === "writeFollowUps"
      ? { result: { questions: ["Who should receive it?"] } }
      : {
          result: {
            to: "team@example.com",
            subject: "Deploy pipeline is faster",
            body: "Hi team, deploys are twice as fast now.",
          },
        },
} satisfies Partial<AgentRequestExecutors>;

/** The prompt check is a Jev judgment: every boolean question scripted to the same answer. */
const judgment = (complete: boolean | number) => ({
  evaluatePrompt: createEvaluatePrompt(createMockJudge({ "*": complete }).model),
});
const actors = judgment(true);

/** Start the machine and deliver the opening request as free text. */
async function openAtReview() {
  const opened = await runAgent(emailDrafter, { input: undefined, executors, actors });
  if (opened.status !== "idle") throw new Error(`Expected idle, got ${opened.status}`);
  return runAgent(emailDrafter, {
    snapshot: opened.snapshot,
    event: eventFromInteraction(opened.snapshot, { text: "Tell the team deploys are faster." }),
    executors,
    actors,
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
      actors,
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
  const opened = await runAgent(emailDrafter, { input: undefined, executors, actors });
  if (opened.status !== "idle") throw new Error(`Expected idle, got ${opened.status}`);

  const result = await runAgent(emailDrafter, {
    snapshot: opened.snapshot,
    event: eventFromInteraction(opened.snapshot, { text: "Anything." }),
    executors,
    // A judge with no scripted answers: the judgment call fails.
    actors: { evaluatePrompt: createEvaluatePrompt(createMockJudge({}).model) },
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
    actors,
  });
  if (sent.status !== "idle") throw new Error("expected the 'draft another?' pause");

  const done = await runAgent(emailDrafter, {
    snapshot: sent.snapshot,
    event: eventFromInteraction(sent.snapshot, { type: "END" }),
    executors,
    actors,
  });

  expect(done.status).toBe("done");
  if (done.status !== "done") return;
  expect(done.output.sentEmails).toHaveLength(1);
  expect(done.output.sentEmails[0]?.to).toBe("team@example.com");
  expect(done.output.failure).toBeNull();
});

test("the prompt check asks Jev one boolean question per required detail, and the threshold decides what is missing", async () => {
  const jev = createMockJudge({
    satisfied: 0.9,
    recipient: ASSESSMENT_THRESHOLD - 0.01,
    "*": ASSESSMENT_THRESHOLD,
  });
  const requests: string[] = [];
  const opened = await runAgent(emailDrafter, { input: undefined, executors });
  if (opened.status !== "idle") throw new Error(`Expected idle, got ${opened.status}`);

  const result = await runAgent(emailDrafter, {
    snapshot: opened.snapshot,
    event: eventFromInteraction(opened.snapshot, { text: "Tell them deploys are faster." }),
    executors: {
      generateText: async (request) => {
        requests.push(request.name ?? request.model);
        return executors.generateText(request);
      },
    },
    actors: { evaluatePrompt: createEvaluatePrompt(jev.model) },
  });

  expect(jev.calls).toHaveLength(1);
  const call = jev.calls[0]!;
  expect(call.state).toEqual({
    request: "Tell them deploys are faster.",
    requiredDetails: REQUIRED_DETAILS,
  });
  expect(Object.keys(call.questions)).toEqual(["satisfied", ...Object.keys(REQUIRED_DETAILS)]);
  expect(Object.values(call.questions).every((question) => question.type === "boolean")).toBe(true);

  // Just under the threshold is missing; exactly at it is stated. Only then
  // does the text model word a follow-up, and the human is asked.
  if (result.status !== "idle") throw new Error(`Expected idle, got ${result.status}`);
  expect(result.snapshot.matches("needsMoreInfo")).toBe(true);
  expect(result.snapshot.context.assessment).toEqual({
    satisfied: false,
    missing: ["recipient"],
    questions: ["Who should receive it?"],
  });
  expect(requests).toEqual(["writeFollowUps"]);
});

test("a complete request skips the follow-up request and goes straight to drafting", async () => {
  const requests: string[] = [];
  const opened = await runAgent(emailDrafter, { input: undefined, executors, actors });
  if (opened.status !== "idle") throw new Error(`Expected idle, got ${opened.status}`);

  const result = await runAgent(emailDrafter, {
    snapshot: opened.snapshot,
    event: eventFromInteraction(opened.snapshot, {
      text: "Email team@example.com: deploys are faster.",
    }),
    executors: {
      generateText: async (request) => {
        requests.push(request.name ?? request.model);
        return executors.generateText(request);
      },
    },
    actors: judgment(ASSESSMENT_THRESHOLD),
  });

  if (result.status !== "idle") throw new Error(`Expected idle, got ${result.status}`);
  expect(result.snapshot.matches("reviewing")).toBe(true);
  expect(requests).toEqual(["draftEmail"]);
});
