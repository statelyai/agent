import { describe, expect, test } from "vitest";
import { runAgent } from "@statelyai/agent";
import type { AgentRequestExecutor } from "@statelyai/agent";
import { escalationLabel, MAX_REPLY_ATTEMPTS, slaNoteFor, triageMachine } from "./index.js";

const TICKET = "I was charged twice for my March subscription. Please refund the duplicate.";

const REPLY = "Thanks for flagging the duplicate charge. We will refund it within 3 days.";

/** Answers each request by name, not by call order. */
function scriptedExecutor(
  classification: Record<string, unknown>,
  reply: string | Error = REPLY,
): { generateText: AgentRequestExecutor; prompts: (string | undefined)[] } {
  const prompts: (string | undefined)[] = [];
  const generateText: AgentRequestExecutor = async (request) => {
    prompts.push(request.prompt);
    switch (request.name) {
      case "classifyTicket":
        return { output: classification };
      case "draftReply":
        if (reply instanceof Error) throw reply;
        return { output: { reply } };
      default:
        throw new Error(`Unexpected request '${request.name}'.`);
    }
  };
  return { generateText, prompts };
}

describe("ticket-triage", () => {
  test("confident classification replies straight through, summary leads the output", async () => {
    const { generateText, prompts } = scriptedExecutor({
      sentiment: "negative",
      category: "billing",
      confidence: 0.95,
    });

    const result = await runAgent(triageMachine, {
      input: { ticket: TICKET },
      executors: { generateText },
    });

    expect(result.status).toBe("done");
    if (result.status !== "done") throw new Error("expected done");

    // The classify prompt is the raw ticket; the draft prompt carries the
    // classification and the simulated SLA.
    expect(prompts[0]).toBe(TICKET);
    expect(prompts[1]).toContain("SLA: first response due in 2h");
    expect(Object.keys(result.output)[0]).toBe("summary");
    expect(result.output.summary).toContain("refund");
    expect(result.output.summary).toContain("SLA");
    expect(result.output.category).toBe("billing");
    expect(result.output.sentiment).toBe("negative");
    expect(result.output.reply).toBe(REPLY);
    expect(result.output.escalated).toBe(false);
  });

  test("low confidence settles idle for a human, who reclassifies with free text", async () => {
    const { generateText } = scriptedExecutor({
      sentiment: "neutral",
      category: "other",
      confidence: 0.3,
    });

    const first = await runAgent(triageMachine, {
      input: { ticket: "hi" },
      executors: { generateText },
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
    });

    expect(result.status).toBe("done");
    if (result.status !== "done") throw new Error("expected done");
    expect(result.output.category).toBe("technical");
    expect(result.output.escalated).toBe(true);
    expect(result.output.summary).toContain("Human set the category to technical");
  });

  test("an unknown category keeps the turn and explains why", async () => {
    const { generateText } = scriptedExecutor({
      sentiment: "neutral",
      category: "other",
      confidence: 0.2,
    });

    const first = await runAgent(triageMachine, {
      input: { ticket: "hi" },
      executors: { generateText },
    });
    if (first.status !== "idle") throw new Error("expected idle");

    const again = await runAgent(triageMachine, {
      snapshot: first.persist(),
      event: { type: "RECLASSIFY", category: "urgent" },
      executors: { generateText },
    });

    // Still waiting on the human, now with the reason in the label.
    expect(again.status).toBe("idle");
    if (again.status !== "idle") throw new Error("expected idle");
    expect(again.snapshot.value).toBe("escalating");
    expect(escalationLabel(again.snapshot)).toContain('"urgent" is not a category');
  });

  test("CONFIRM accepts the model's category and drafts the reply", async () => {
    const { generateText } = scriptedExecutor({
      sentiment: "negative",
      category: "billing",
      confidence: 0.4,
    });

    const first = await runAgent(triageMachine, {
      input: { ticket: TICKET },
      executors: { generateText },
    });
    if (first.status !== "idle") throw new Error("expected idle");

    const result = await runAgent(triageMachine, {
      snapshot: first.persist(),
      event: { type: "CONFIRM" },
      executors: { generateText },
    });

    expect(result.status).toBe("done");
    if (result.status !== "done") throw new Error("expected done");
    expect(result.output.category).toBe("billing");
    expect(result.output.summary).toContain("Human confirmed billing");
  });

  test("a failing draft retries once, then degrades to a holding reply", async () => {
    let calls = 0;
    const generateText: AgentRequestExecutor = async (request) => {
      calls += 1;
      if (request.name === "classifyTicket") {
        return { output: { sentiment: "negative", category: "billing", confidence: 0.9 } };
      }
      throw new Error("model unavailable");
    };

    const result = await runAgent(triageMachine, {
      input: { ticket: TICKET },
      executors: { generateText },
    });

    expect(result.status).toBe("done");
    if (result.status !== "done") throw new Error("expected done");
    // One classify call plus MAX_REPLY_ATTEMPTS draft attempts.
    expect(calls).toBe(1 + MAX_REPLY_ATTEMPTS);
    expect(result.output.reply).toContain("a support agent is picking it up now");
    expect(result.output.summary).toContain("failed twice");
  });

  test("an out-of-enum category fails validation and ends in `unclassified`", async () => {
    const generateText: AgentRequestExecutor = async () => ({
      // `category` is not one of billing|technical|other.
      output: { sentiment: "neutral", category: "not-a-category", confidence: 0.9 },
    });

    const result = await runAgent(triageMachine, {
      input: { ticket: TICKET },
      executors: { generateText },
    });

    // The classify invoke's `onError` catches the schema violation, so the run
    // finishes with a holding reply instead of an unmodeled error state.
    expect(result.status).toBe("done");
    if (result.status !== "done") throw new Error("expected done");
    expect(result.output.category).toBe(null);
    expect(result.output.sentiment).toBe(null);
    expect(result.output.escalated).toBe(true);
    expect(result.output.summary).toContain("Could not classify");
  });

  test("a classifier that omits confidence is not trusted: the ticket escalates", async () => {
    const { generateText } = scriptedExecutor({ sentiment: "neutral", category: "technical" });

    const result = await runAgent(triageMachine, {
      input: { ticket: TICKET },
      executors: { generateText },
    });

    expect(result.status).toBe("done");
    if (result.status !== "done") throw new Error("expected done");
    expect(result.output.escalated).toBe(true);
    expect(result.output.summary).toContain("Could not classify");
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
