import { describe, expect, test } from "vitest";
import { runAgent } from "@statelyai/agent";
import type { AgentDecisionRequest, AgentRequestExecutor, ChosenEvent } from "@statelyai/agent";
import { jokeMachine } from "./index.js";

// Streaming joke executor: emits chunks and returns the accumulated text. The
// revision prompt (the improvement pass) yields a distinct, better joke.
const streamText: AgentRequestExecutor = async (request) => {
  const prompt = request.prompt ?? "";
  const topic =
    prompt.match(/Tell a joke about (.*)\./)?.[1] ?? prompt.match(/Previous joke about (.*):/)?.[1];
  const joke = prompt.includes("Rewrite it")
    ? `A better joke about ${topic ?? "?"}.`
    : `A joke about ${topic ?? "?"}.`;
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
  test("always takes one improvement pass, even when the first joke rates well", async () => {
    const revisionPrompts: string[] = [];
    let decideCount = 0;

    const result = await runAgent(jokeMachine, {
      input: { topic: "penguins" },
      executors: {
        streamText: async (request, info) => {
          if (request.prompt?.includes("Rewrite it")) revisionPrompts.push(request.prompt);
          return streamText(request, info);
        },
        generateText: createRater([9, 10]),
        decide: async (_request: AgentDecisionRequest): Promise<{ event: ChosenEvent }> => {
          decideCount += 1;
          return { event: { type: "END" } };
        },
      },
    });

    expect(result.status).toBe("done");
    if (result.status !== "done") throw new Error("expected done");
    // A 9/10 first joke still gets revised: the machine owns that rule.
    expect(revisionPrompts).toHaveLength(1);
    expect(revisionPrompts[0]).toContain("A joke about penguins.");
    expect(revisionPrompts[0]).toContain("scored it 9/10");
    // The decision only runs after the improvement pass.
    expect(decideCount).toBe(1);
    expect(result.output.topic).toBe("penguins");
    expect(result.output.firstJoke).toBe("A joke about penguins.");
    expect(result.output.joke).toBe("A better joke about penguins.");
    expect(result.output.jokes).toEqual([
      "A joke about penguins.",
      "A better joke about penguins.",
    ]);
    expect(result.output.revisionNotice).toContain("First attempt scored 9/10");
    expect(result.output.revisionNotice).toContain("improvement pass");
    expect(result.output.lastRating).toBe(10);
  });

  test("the decision event drives the loop: TELL_ANOTHER re-tells, then the joke cap stops it", async () => {
    let decideCount = 0;

    const result = await runAgent(jokeMachine, {
      input: { topic: "state machines" },
      executors: {
        streamText,
        generateText: createRater([3, 4, 8]),
        decide: async (): Promise<{ event: ChosenEvent }> => {
          decideCount += 1;
          return { event: { type: "TELL_ANOTHER" } };
        },
      },
    });

    expect(result.status).toBe("done");
    if (result.status !== "done") throw new Error("expected done");
    // Revision (machine-owned) → decide TELL_ANOTHER → third joke hits the cap,
    // so the run ends without asking again.
    expect(decideCount).toBe(1);
    expect(result.output.jokes).toHaveLength(3);
    expect(result.output.lastRating).toBe(8);
  });

  test("the model can end the loop after the improvement pass", async () => {
    let decideCount = 0;

    const result = await runAgent(jokeMachine, {
      input: { topic: "state machines" },
      executors: {
        streamText,
        generateText: createRater([3, 8]),
        decide: async (): Promise<{ event: ChosenEvent }> => {
          decideCount += 1;
          return { event: { type: "END" } };
        },
      },
    });

    expect(result.status).toBe("done");
    if (result.status !== "done") throw new Error("expected done");
    expect(decideCount).toBe(1);
    expect(result.output.jokes).toHaveLength(2);
    expect(result.output.lastRating).toBe(8);
  });
});
