import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { createAgentRuntime, runToQuiescence } from "@statelyai/agent";
import type { AgentRequestExecutor } from "@statelyai/agent";
import { createMockJudge, type MockJudgeEntry, type MockJudgeModel } from "../mock-judge.js";
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
 * The classifier's judge answers, by question name. The mock judge wraps
 * `doEvaluate` to report Jev's `category` confidence the way TypeSafe does, in
 * `providerMetadata.typesafe.confidence`: 0.9 by default, or `confidence` so a
 * test can land below the threshold.
 */
function classifier(
  answers: { category?: MockJudgeEntry; sentiment?: MockJudgeEntry },
  confidence = 0.9,
) {
  const script: Record<string, MockJudgeEntry> = {};
  if (answers.category !== undefined) script.category = answers.category;
  if (answers.sentiment !== undefined) script.sentiment = answers.sentiment;
  const judge = createMockJudge(script);
  const model: MockJudgeModel = {
    ...judge.model,
    doEvaluate: async (options) => ({
      ...(await judge.model.doEvaluate(options)),
      providerMetadata: { typesafe: { confidence: { category: confidence } } },
    }),
  };
  return { calls: judge.calls, actors: { classifyTicket: createClassifyTicket(model) } };
}

describe("ticket-triage", () => {
  test("confident classification replies straight through, summary leads the output", async () => {
    const { generateText, prompts } = scriptedExecutor();
    const jev = classifier({ sentiment: "negative", category: "billing" });

    const result = await runToQuiescence(
      createAgentRuntime(triageMachine, {
        executors: { generateText },
        actors: jev.actors,
      }),
      {
        input: { ticket: TICKET },
      },
    );

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

    const first = await runToQuiescence(
      createAgentRuntime(triageMachine, {
        executors: { generateText },
        actors,
      }),
      {
        input: { ticket: "hi" },
      },
    );

    // Nothing is in flight in `escalating`, so the run settles idle there.
    expect(first.status).toBe("idle");
    if (first.status !== "idle") throw new Error("expected idle");
    expect(first.snapshot.value).toBe("escalating");
    // The interaction label interpolates its {contextKey} placeholders.
    const label = escalationLabel(first.snapshot);
    expect(label).toContain("Low confidence (0.3)");
    expect(label).toContain("SLA: first response due in 24h");
    expect(label).toContain("Confirm the category");

    const result = await runToQuiescence(
      createAgentRuntime(triageMachine, {
        executors: { generateText },
        actors,
      }),
      {
        snapshot: first.persist(),
        event: { type: "RECLASSIFY", category: "Technical" },
      },
    );

    expect(result.status).toBe("done");
    if (result.status !== "done") throw new Error("expected done");
    expect(result.output.category).toBe("technical");
    expect(result.output.escalated).toBe(true);
    expect(result.output.summary).toContain("Human set the category to technical");
  });

  test("an unknown category keeps the turn and explains why", async () => {
    const { generateText } = scriptedExecutor();
    const { actors } = classifier({ sentiment: "neutral", category: "other" }, 0.2);

    const first = await runToQuiescence(
      createAgentRuntime(triageMachine, {
        executors: { generateText },
        actors,
      }),
      {
        input: { ticket: "hi" },
      },
    );
    if (first.status !== "idle") throw new Error("expected idle");

    const again = await runToQuiescence(
      createAgentRuntime(triageMachine, {
        executors: { generateText },
        actors,
      }),
      {
        snapshot: first.persist(),
        event: { type: "RECLASSIFY", category: "urgent" },
      },
    );

    // Still waiting on the human, now with the reason in the label.
    expect(again.status).toBe("idle");
    if (again.status !== "idle") throw new Error("expected idle");
    expect(again.snapshot.value).toBe("escalating");
    expect(escalationLabel(again.snapshot)).toContain('"urgent" is not a category');
  });

  test("CONFIRM accepts the model's category and drafts the reply", async () => {
    const { generateText } = scriptedExecutor();
    const { actors } = classifier({ sentiment: "negative", category: "billing" }, 0.4);

    const first = await runToQuiescence(
      createAgentRuntime(triageMachine, {
        executors: { generateText },
        actors,
      }),
      {
        input: { ticket: TICKET },
      },
    );
    if (first.status !== "idle") throw new Error("expected idle");

    const result = await runToQuiescence(
      createAgentRuntime(triageMachine, {
        executors: { generateText },
        actors,
      }),
      {
        snapshot: first.persist(),
        event: { type: "CONFIRM" },
      },
    );

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

    const result = await runToQuiescence(
      createAgentRuntime(triageMachine, {
        executors: { generateText },
        actors: jev.actors,
      }),
      {
        input: { ticket: TICKET },
      },
    );

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

    const result = await runToQuiescence(
      createAgentRuntime(triageMachine, {
        executors: { generateText },
        actors,
      }),
      {
        input: { ticket: TICKET },
      },
    );

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

    const result = await runToQuiescence(
      createAgentRuntime(triageMachine, {
        executors: { generateText },
        actors,
      }),
      {
        input: { ticket: TICKET },
      },
    );

    expect(result.status).toBe("done");
    if (result.status !== "done") throw new Error("expected done");
    expect(result.output.escalated).toBe(true);
    expect(result.output.summary).toContain("Could not classify");
  });

  test("the classifier asks Jev two choices over the ticket; confidence just under the threshold escalates", async () => {
    const { generateText } = scriptedExecutor();
    const at = classifier({ sentiment: "neutral", category: "technical" }, CONFIDENCE_THRESHOLD);
    const confident = await runToQuiescence(
      createAgentRuntime(triageMachine, {
        executors: { generateText },
        actors: at.actors,
      }),
      {
        input: { ticket: TICKET },
      },
    );

    const call = at.calls[0]!;
    expect(call.state).toEqual({ ticket: TICKET });
    expect(Object.keys(call.questions)).toEqual(["category", "sentiment"]);
    const questions = call.questions as Record<string, { type: string; criteria: object }>;
    expect(questions.category!.type).toBe("choice");
    expect(Object.keys(questions.category!.criteria)).toEqual(["billing", "technical", "other"]);
    expect(questions.sentiment!.type).toBe("choice");
    expect(Object.keys(questions.sentiment!.criteria)).toEqual(["positive", "neutral", "negative"]);
    expect(confident.status).toBe("done");

    const under = await runToQuiescence(
      createAgentRuntime(triageMachine, {
        executors: { generateText },
        actors: classifier(
          { sentiment: "neutral", category: "technical" },
          CONFIDENCE_THRESHOLD - 0.01,
        ).actors,
      }),
      {
        input: { ticket: TICKET },
      },
    );
    expect(under.status).toBe("idle");
    if (under.status !== "idle") throw new Error("expected idle");
    expect(under.snapshot.value).toBe("escalating");
  });

  test("one starter demonstrates escalation: a ticket that fits two queues", async () => {
    // QA regression: the old vague starter landed in `other` at confidence 1
    // (the criteria send vague tickets there on purpose), so no starter showed
    // the human-in-the-loop path. A ticket that is both billing (invoice,
    // receipt) and technical (a 500 error) splits Jev's category probability;
    // against the real model it scored 0.31–0.42 over 11 runs.
    const starters = JSON.parse(readFileSync(new URL("./metadata.json", import.meta.url), "utf8"))
      .starters as string[];
    const twoQueues = starters.find(
      (starter) => /invoice/i.test(starter) && /500 error/.test(starter),
    );
    expect(twoQueues).toBeDefined();

    const { generateText } = scriptedExecutor();
    const { actors } = classifier({ sentiment: "neutral", category: "billing" }, 0.35);
    const result = await runToQuiescence(
      createAgentRuntime(triageMachine, {
        executors: { generateText },
        actors,
      }),
      {
        input: { ticket: twoQueues! },
      },
    );

    expect(result.status).toBe("idle");
    if (result.status !== "idle") throw new Error("expected idle");
    expect(result.snapshot.value).toBe("escalating");
    expect(escalationLabel(result.snapshot)).toContain('Low confidence (0.35) on "billing"');
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
