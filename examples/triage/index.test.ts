import { describe, expect, test } from "vitest";
import type { TypeSafeClient } from "@typesafe-ai/sdk";
import { runAgent } from "@statelyai/agent";
import type { AgentRequestExecutor } from "@statelyai/agent";
import { createMockJevClient, type MockJevEntry } from "../mock-jev.js";
import {
  CONFIDENCE_THRESHOLD,
  createClassifyTicket,
  escalationLabel,
  MAX_REPLY_ATTEMPTS,
  slaNoteFor,
  triageMachine,
} from "./index.js";

const TICKET = "I was charged twice for my March subscription. Please refund the duplicate.";

const REPLY = "Thanks for flagging the duplicate charge. We will refund it within 3 days.";

/** Answers the one text request (`draftReply`) by name, not by call order. */
function scriptedExecutor(reply: string | Error = REPLY): {
  generateText: AgentRequestExecutor;
  prompts: (string | undefined)[];
} {
  const prompts: (string | undefined)[] = [];
  const generateText: AgentRequestExecutor = async (request) => {
    prompts.push(request.prompt);
    switch (request.name) {
      case "draftReply":
        if (reply instanceof Error) throw reply;
        return { result: { reply } };
      default:
        throw new Error(`Unexpected request '${request.name}'.`);
    }
  };
  return { generateText, prompts };
}

/**
 * The classifier's Jev answers, by question name. `mock-jev` reports every
 * `choice` at confidence 0.9; `confidence` overrides the `category` answer's
 * value after the real SDK parse, so a test can land below the threshold.
 */
function classifier(
  answers: { category?: MockJevEntry; sentiment?: MockJevEntry },
  confidence?: number,
) {
  const script: Record<string, MockJevEntry> = {};
  if (answers.category !== undefined) script.category = answers.category;
  if (answers.sentiment !== undefined) script.sentiment = answers.sentiment;
  const jev = createMockJevClient(script);
  let client: TypeSafeClient = jev.client;
  if (confidence !== undefined) {
    const inner = jev.client;
    client = Object.assign(Object.create(inner) as TypeSafeClient, {
      systemOne: async (...args: Parameters<TypeSafeClient["systemOne"]>) => {
        const result = await inner.systemOne(...args);
        const category = result.answers.category!;
        return { ...result, answers: { ...result.answers, category: { ...category, confidence } } };
      },
    });
  }
  return { calls: jev.calls, actors: { classifyTicket: createClassifyTicket(client) } };
}

describe("ticket-triage", () => {
  test("confident classification replies straight through, summary leads the output", async () => {
    const { generateText, prompts } = scriptedExecutor();
    const jev = classifier({ sentiment: "negative", category: "billing" });

    const result = await runAgent(triageMachine, {
      input: { ticket: TICKET },
      executors: { generateText },
      actors: jev.actors,
    });

    expect(result.status).toBe("done");
    if (result.status !== "done") throw new Error("expected done");

    // The classifier's state is the raw ticket; the draft prompt carries the
    // classification and the simulated SLA.
    expect(jev.calls[0]!.state).toEqual({ ticket: TICKET });
    expect(prompts[0]).toContain("SLA: first response due in 2h");
    expect(Object.keys(result.output)[0]).toBe("summary");
    expect(result.output.summary).toContain("refund");
    expect(result.output.summary).toContain("SLA");
    expect(result.output.category).toBe("billing");
    expect(result.output.sentiment).toBe("negative");
    expect(result.output.reply).toBe(REPLY);
    expect(result.output.escalated).toBe(false);
  });

  test("low confidence settles idle for a human, who reclassifies with free text", async () => {
    const { generateText } = scriptedExecutor();
    const { actors } = classifier({ sentiment: "neutral", category: "other" }, 0.3);

    const first = await runAgent(triageMachine, {
      input: { ticket: "hi" },
      executors: { generateText },
      actors,
    });

    // The `waiting` tag + isIdle settles this deterministically.
    expect(first.status).toBe("idle");
    if (first.status !== "idle") throw new Error("expected idle");
    expect(first.snapshot.value).toBe("escalating");
    // The interaction label interpolates its {contextKey} placeholders.
    const label = escalationLabel(first.snapshot);
    expect(label).toContain("Low confidence (0.3)");
    expect(label).toContain("SLA: first response due in 24h");
    expect(label).toContain("Confirm the category");

    const result = await runAgent(triageMachine, {
      snapshot: first.persist(),
      event: { type: "RECLASSIFY", category: "Technical" },
      executors: { generateText },
      actors,
    });

    expect(result.status).toBe("done");
    if (result.status !== "done") throw new Error("expected done");
    expect(result.output.category).toBe("technical");
    expect(result.output.escalated).toBe(true);
    expect(result.output.summary).toContain("Human set the category to technical");
  });

  test("an unknown category keeps the turn and explains why", async () => {
    const { generateText } = scriptedExecutor();
    const { actors } = classifier({ sentiment: "neutral", category: "other" }, 0.2);

    const first = await runAgent(triageMachine, {
      input: { ticket: "hi" },
      executors: { generateText },
      actors,
    });
    if (first.status !== "idle") throw new Error("expected idle");

    const again = await runAgent(triageMachine, {
      snapshot: first.persist(),
      event: { type: "RECLASSIFY", category: "urgent" },
      executors: { generateText },
      actors,
    });

    // Still waiting on the human, now with the reason in the label.
    expect(again.status).toBe("idle");
    if (again.status !== "idle") throw new Error("expected idle");
    expect(again.snapshot.value).toBe("escalating");
    expect(escalationLabel(again.snapshot)).toContain('"urgent" is not a category');
  });

  test("CONFIRM accepts the model's category and drafts the reply", async () => {
    const { generateText } = scriptedExecutor();
    const { actors } = classifier({ sentiment: "negative", category: "billing" }, 0.4);

    const first = await runAgent(triageMachine, {
      input: { ticket: TICKET },
      executors: { generateText },
      actors,
    });
    if (first.status !== "idle") throw new Error("expected idle");

    const result = await runAgent(triageMachine, {
      snapshot: first.persist(),
      event: { type: "CONFIRM" },
      executors: { generateText },
      actors,
    });

    expect(result.status).toBe("done");
    if (result.status !== "done") throw new Error("expected done");
    expect(result.output.category).toBe("billing");
    expect(result.output.summary).toContain("Human confirmed billing");
  });

  test("a failing draft retries once, then degrades to a holding reply", async () => {
    let calls = 0;
    const generateText: AgentRequestExecutor = async () => {
      calls += 1;
      throw new Error("model unavailable");
    };
    const jev = classifier({ sentiment: "negative", category: "billing" });

    const result = await runAgent(triageMachine, {
      input: { ticket: TICKET },
      executors: { generateText },
      actors: jev.actors,
    });

    expect(result.status).toBe("done");
    if (result.status !== "done") throw new Error("expected done");
    // One classify call plus MAX_REPLY_ATTEMPTS draft attempts.
    expect(jev.calls.length + calls).toBe(1 + MAX_REPLY_ATTEMPTS);
    expect(result.output.reply).toContain("a support agent is picking it up now");
    expect(result.output.summary).toContain("failed twice");
  });

  test("an out-of-enum category fails the call and ends in `unclassified`", async () => {
    const { generateText } = scriptedExecutor();
    // `category` is not one of billing|technical|other, so the Jev call fails.
    const { actors } = classifier({ sentiment: "neutral", category: "not-a-category" });

    const result = await runAgent(triageMachine, {
      input: { ticket: TICKET },
      executors: { generateText },
      actors,
    });

    // The classify invoke's `onError` catches the failure, so the run
    // finishes with a holding reply instead of an unmodeled error state.
    expect(result.status).toBe("done");
    if (result.status !== "done") throw new Error("expected done");
    expect(result.output.category).toBe(null);
    expect(result.output.sentiment).toBe(null);
    expect(result.output.escalated).toBe(true);
    expect(result.output.summary).toContain("Could not classify");
  });

  test("a classifier that returns no category is not trusted: the ticket escalates", async () => {
    const { generateText } = scriptedExecutor();
    const { actors } = classifier({ sentiment: "neutral" });

    const result = await runAgent(triageMachine, {
      input: { ticket: TICKET },
      executors: { generateText },
      actors,
    });

    expect(result.status).toBe("done");
    if (result.status !== "done") throw new Error("expected done");
    expect(result.output.escalated).toBe(true);
    expect(result.output.summary).toContain("Could not classify");
  });

  test("the classifier asks Jev two choices over the ticket; confidence just under the threshold escalates", async () => {
    const { generateText } = scriptedExecutor();
    const at = classifier({ sentiment: "neutral", category: "technical" }, CONFIDENCE_THRESHOLD);
    const confident = await runAgent(triageMachine, {
      input: { ticket: TICKET },
      executors: { generateText },
      actors: at.actors,
    });

    const call = at.calls[0]!;
    expect(call.state).toEqual({ ticket: TICKET });
    expect(Object.keys(call.questions)).toEqual(["category", "sentiment"]);
    const questions = call.questions as Record<string, { type: string; criteria: object }>;
    expect(questions.category!.type).toBe("choice");
    expect(Object.keys(questions.category!.criteria)).toEqual(["billing", "technical", "other"]);
    expect(questions.sentiment!.type).toBe("choice");
    expect(Object.keys(questions.sentiment!.criteria)).toEqual(["positive", "neutral", "negative"]);
    expect(confident.status).toBe("done");

    const under = await runAgent(triageMachine, {
      input: { ticket: TICKET },
      executors: { generateText },
      actors: classifier(
        { sentiment: "neutral", category: "technical" },
        CONFIDENCE_THRESHOLD - 0.01,
      ).actors,
    });
    expect(under.status).toBe("idle");
    if (under.status !== "idle") throw new Error("expected idle");
    expect(under.snapshot.value).toBe("escalating");
  });

  test("the simulated SLA tightens for negative tickets", () => {
    expect(slaNoteFor({ category: "billing", sentiment: "neutral", confidence: 1 })).toContain(
      "in 4h",
    );
    expect(slaNoteFor({ category: "billing", sentiment: "negative", confidence: 1 })).toContain(
      "in 2h",
    );
  });
});
