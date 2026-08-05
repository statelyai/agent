import { describe, expect, test } from "vitest";
import { runAgent } from "@statelyai/agent";
import type { AgentRequestExecutor } from "@statelyai/agent";
import { triageMachine } from "./index.js";

const TICKET = "I was charged twice for my March subscription. Please refund the duplicate.";

describe("ticket-triage", () => {
  test("triages the ticket: prompt carries the text, structured classification lands in the output", async () => {
    const prompts: (string | undefined)[] = [];
    const classification = {
      sentiment: "negative" as const,
      category: "billing" as const,
      reply: "Thanks for flagging the duplicate charge. We will refund it within 3 days.",
    };

    const generateText: AgentRequestExecutor = async (request) => {
      prompts.push(request.prompt);
      return { output: classification };
    };

    const result = await runAgent(triageMachine, {
      input: { ticket: TICKET },
      executors: { generateText },
    });

    expect(result.status).toBe("done");
    if (result.status !== "done") throw new Error("expected done");

    // The invoke input threaded the raw ticket text into the model prompt.
    expect(prompts).toEqual([TICKET]);
    // A readable summary leads, with the structured triage fields alongside it.
    expect(result.output).toEqual({
      summary: expect.stringContaining("refund"),
      ...classification,
    });
    expect(Object.keys(result.output)[0]).toBe("summary");
    expect(result.output.category).toBe("billing");
    expect(result.output.sentiment).toBe("negative");
    expect(result.output.reply).toContain("refund");
  });

  test("output is validated against the triage schema: an out-of-enum category settles a machine error", async () => {
    const generateText: AgentRequestExecutor = async () => ({
      // `category` is not one of billing|technical|other.
      output: { sentiment: "neutral", category: "not-a-category", reply: "..." },
    });

    const result = await runAgent(triageMachine, {
      input: { ticket: TICKET },
      executors: { generateText },
    });

    // No onError handler -> schema-validation failure surfaces as an error.
    expect(result.status).toBe("error");
  });
});
