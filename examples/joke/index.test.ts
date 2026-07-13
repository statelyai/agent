import { describe, expect, test } from "vitest";
import { runAgent } from "../../src/index.js";
import type { AgentDecisionRequest, AgentRequestExecutor, ChosenEvent } from "../../src/index.js";
import { jokeMachine } from "./index.js";

// Streaming joke executor: emits chunks and returns the accumulated text.
const streamText: AgentRequestExecutor = async (request) => {
  const topic = request.prompt?.match(/joke about (.*)\./)?.[1] ?? "?";
  const joke = `A joke about ${topic}.`;
  return { output: joke };
};

// Structured rating executor.
function createRater(ratings: number[]): AgentRequestExecutor {
  let i = 0;
  return async () => ({
    output: { rating: ratings[i++] ?? 8, explanation: "because" },
  });
}

describe("joke-teller", () => {
  test("tells a joke for the topic, parses the rating, and the decision ends the loop", async () => {
    const seenTopics: string[] = [];
    const rate = createRater([9]);

    const result = await runAgent(jokeMachine, {
      input: { topic: "penguins" },
      executors: {
        streamText: async (request, info) => {
          seenTopics.push(request.prompt?.match(/joke about (.*)\./)?.[1] ?? "");
          return streamText(request, info);
        },
        generateText: rate,
        decide: async (request: AgentDecisionRequest): Promise<{ event: ChosenEvent }> => {
          // High rating -> END.
          return { event: { type: "END" } };
        },
      },
    });

    expect(result.status).toBe("done");
    if (result.status !== "done") throw new Error("expected done");
    expect(seenTopics).toEqual(["penguins"]);
    expect(result.output.topic).toBe("penguins");
    expect(result.output.jokes).toEqual(["A joke about penguins."]);
    expect(result.output.lastRating).toBe(9);
  });

  test("the decision event drives the loop: TELL_ANOTHER re-tells before END", async () => {
    let decideCount = 0;

    const result = await runAgent(jokeMachine, {
      input: { topic: "state machines" },
      executors: {
        streamText,
        generateText: createRater([3, 8]),
        decide: async (): Promise<{ event: ChosenEvent }> => {
          decideCount += 1;
          // First joke rated low -> loop; second -> end.
          return { event: { type: decideCount === 1 ? "TELL_ANOTHER" : "END" } };
        },
      },
    });

    expect(result.status).toBe("done");
    if (result.status !== "done") throw new Error("expected done");
    expect(decideCount).toBe(2);
    expect(result.output.jokes).toHaveLength(2);
    expect(result.output.lastRating).toBe(8);
  });
});
