import { describe, expect, test } from "vitest";
import type { AgentRequestExecutor } from "@statelyai/agent";
import { createTextLogic } from "@statelyai/agent";
import { z } from "zod";
import { tellJoke } from "../joke/index.js";
import { runStreamingDemo, runTriageDemo } from "./index.js";

/**
 * Mock `generateText` for the triage machine: returns a canned structured
 * payload covering both requests the machine makes (`classifyTicket`, then
 * `draftReply`) and records every prompt it saw. A `done` run calls it exactly
 * twice, and the machine's structured output must flow straight through.
 */
function createTriageModel() {
  const tickets: string[] = [];
  const generateText: AgentRequestExecutor = async (request) => {
    tickets.push(request.prompt ?? "");
    return {
      output: {
        sentiment: "negative" as const,
        category: "billing" as const,
        confidence: 0.9,
        reply: "We are sorry about the duplicate charge and will refund it.",
      },
    };
  };
  return { generateText, tickets };
}

describe("ai-sdk-host", () => {
  test("runTriageDemo routes the ticket through generateText and returns structured output", async () => {
    const { generateText, tickets } = createTriageModel();

    const output = await runTriageDemo("I was charged twice.", generateText);

    // The machine's final output composes a `summary` around the structured
    // fields, so match the fields the model produced rather than exact equality.
    expect(output).toMatchObject({
      sentiment: "negative",
      category: "billing",
      reply: "We are sorry about the duplicate charge and will refund it.",
      // Confidence cleared the threshold, so no human was pulled in.
      escalated: false,
    });
    expect((output as { summary: string }).summary).toContain(
      "We are sorry about the duplicate charge and will refund it.",
    );
    // Two text requests: classification gets the raw ticket, the draft gets the
    // ticket plus the classification and the SLA note the machine computed.
    expect(tickets).toHaveLength(2);
    expect(tickets[0]).toBe("I was charged twice.");
    expect(tickets[1]).toContain("Ticket (billing, customer sounds negative):");
    expect(tickets[1]).toContain("SLA: first response due in 2h (billing, negative).");
  });

  test("runStreamingDemo settles on the accumulated final joke", async () => {
    const topics: string[] = [];
    // Stand-in stream logic: assembles the joke from parts (as a real stream
    // would) and hands the machine only the accumulated final text.
    const streamingTellJoke = createTextLogic({
      mode: "stream",
      schemas: tellJoke.schemas,
      model: "jokeWriter",
      prompt: ({ input }) => `Tell a joke about ${input.topic}.`,
    }).withExecutor(async ({ input }) => {
      topics.push(input.topic);
      return { output: ["A joke about ", input.topic, "."].join("") };
    });

    const joke = await runStreamingDemo("state machines", streamingTellJoke);

    // The machine transitions only on the accumulated final text.
    expect(joke).toBe("A joke about state machines.");
    // The topic was lowered into the stream logic's input, once per pass — the
    // joke machine always takes one improvement pass before deciding.
    expect(topics).toEqual(["state machines", "state machines"]);
  });
});
