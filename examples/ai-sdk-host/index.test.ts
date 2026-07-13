import { describe, expect, test } from "vitest";
import type { AgentRequestExecutor } from "../../src/index.js";
import { createTextLogic } from "../../src/index.js";
import { z } from "zod";
import { runStreamingDemo, runTriageDemo } from "./index.js";

/**
 * Mock `generateText` for the triage machine: returns a canned structured
 * triage object and records every request it saw. The triage machine issues a
 * single text request (`triageTicket`), so a `done` run must call it exactly
 * once, and the machine's structured output must flow straight through.
 */
function createTriageModel() {
  const tickets: string[] = [];
  const generateText: AgentRequestExecutor = async (request) => {
    tickets.push(request.prompt ?? "");
    return {
      output: {
        sentiment: "negative" as const,
        category: "billing" as const,
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

    expect(output).toEqual({
      sentiment: "negative",
      category: "billing",
      reply: "We are sorry about the duplicate charge and will refund it.",
    });
    // The machine lowered the ticket into a single text request's prompt.
    expect(tickets).toEqual(["I was charged twice."]);
  });

  test("runStreamingDemo settles on the accumulated final joke", async () => {
    const topics: string[] = [];
    // Stand-in stream logic: assembles the joke from parts (as a real stream
    // would) and hands the machine only the accumulated final text.
    const streamingTellJoke = createTextLogic({
      mode: "stream",
      schemas: { input: z.object({ topic: z.string() }), output: z.string() },
      model: "jokeWriter",
      prompt: ({ input }) => `Tell a joke about ${input.topic}.`,
    }).withExecutor(async ({ input }) => {
      topics.push(input.topic);
      return { output: ["A joke about ", input.topic, "."].join("") };
    });

    const joke = await runStreamingDemo("state machines", streamingTellJoke);

    // The machine transitions only on the accumulated final text.
    expect(joke).toBe("A joke about state machines.");
    // The topic was lowered into the stream logic's input.
    expect(topics).toEqual(["state machines"]);
  });
});
