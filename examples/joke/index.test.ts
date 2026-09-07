import { describe, expect, test } from "vitest";
import { runAgent } from "@statelyai/agent";
import type { AgentRequestExecutor, ChosenEvent } from "@statelyai/agent";
import { jokeMachine } from "./index.js";

/**
 * Mock executors for one run, routed on `request.name` (the `createTextLogic`
 * name, so no prompt sniffing). `ratings` is the critic's score per rating
 * call; the revision prompt is recognised by `input.previousJoke` being set,
 * which is exactly the machine input that makes `telling` a revision pass.
 */
function createJokeExecutors(options: { ratings: number[]; decision: ChosenEvent["type"] }) {
  const revisionInputs: { topic: string; previousJoke: string; rating: number | null }[] = [];
  let decideCount = 0;
  let ratingIndex = 0;

  const streamText: AgentRequestExecutor = async (request) => {
    if (request.name !== "tellJoke") throw new Error(`unexpected stream request: ${request.name}`);
    const input = request.input as {
      topic: string;
      previousJoke: string | null;
      rating: number | null;
    };
    if (input.previousJoke !== null) {
      revisionInputs.push({
        topic: input.topic,
        previousJoke: input.previousJoke,
        rating: input.rating,
      });
      return { output: `A better joke about ${input.topic}.` };
    }
    return { output: `A joke about ${input.topic}.` };
  };

  const generateText: AgentRequestExecutor = async (request) => {
    if (request.name !== "rateJoke") throw new Error(`unexpected text request: ${request.name}`);
    return {
      output: { rating: options.ratings[ratingIndex++] ?? 8, explanation: "because" },
    };
  };

  const decide = async (): Promise<{ event: ChosenEvent }> => {
    decideCount += 1;
    return { event: { type: options.decision } };
  };

  return {
    executors: { streamText, generateText, decide },
    revisionInputs,
    get decideCount() {
      return decideCount;
    },
  };
}

describe("joke-teller", () => {
  test("always takes one improvement pass, even when the first joke rates well", async () => {
    const mock = createJokeExecutors({ ratings: [9, 10], decision: "END" });

    const result = await runAgent(jokeMachine, {
      input: { topic: "penguins" },
      executors: mock.executors,
    });

    expect(result.status).toBe("done");
    if (result.status !== "done") throw new Error("expected done");
    expect(result.output.status).toBe("told");
    // A 9/10 first joke still gets revised: the machine owns that rule.
    expect(mock.revisionInputs).toEqual([
      { topic: "penguins", previousJoke: "A joke about penguins.", rating: 9 },
    ]);
    // The decision only runs after the improvement pass.
    expect(mock.decideCount).toBe(1);
    expect(result.output.topic).toBe("penguins");
    expect(result.output.firstJoke).toBe("A joke about penguins.");
    expect(result.output.joke).toBe("A better joke about penguins.");
    expect(result.output.jokes).toEqual([
      "A joke about penguins.",
      "A better joke about penguins.",
    ]);
    // The notice is rendered from `firstRating`/`firstExplanation` in `output`,
    // not stored in context.
    expect(result.output.revisionNotice).toContain("First attempt scored 9/10");
    expect(result.output.revisionNotice).toContain("improvement pass");
    expect(result.output.lastRating).toBe(10);
    expect(result.output.error).toBeNull();
  });

  test("the decision event drives the loop: TELL_ANOTHER re-tells, then the joke cap stops it", async () => {
    const mock = createJokeExecutors({ ratings: [3, 4, 8], decision: "TELL_ANOTHER" });

    const result = await runAgent(jokeMachine, {
      input: { topic: "state machines" },
      executors: mock.executors,
    });

    expect(result.status).toBe("done");
    if (result.status !== "done") throw new Error("expected done");
    // Revision (machine-owned) → decide TELL_ANOTHER → third joke hits the cap,
    // so `checkingRating` targets `done` without asking again.
    expect(mock.decideCount).toBe(1);
    expect(result.output.status).toBe("told");
    expect(result.output.jokes).toHaveLength(3);
    expect(result.output.lastRating).toBe(8);
  });

  test("the model can end the loop after the improvement pass", async () => {
    const mock = createJokeExecutors({ ratings: [3, 8], decision: "END" });

    const result = await runAgent(jokeMachine, {
      input: { topic: "state machines" },
      executors: mock.executors,
    });

    expect(result.status).toBe("done");
    if (result.status !== "done") throw new Error("expected done");
    expect(mock.decideCount).toBe(1);
    expect(result.output.status).toBe("told");
    expect(result.output.jokes).toHaveLength(2);
    expect(result.output.lastRating).toBe(8);
  });

  test("a rating failure ends in the failed final state, not a done with an empty joke", async () => {
    const result = await runAgent(jokeMachine, {
      input: { topic: "state machines" },
      executors: {
        streamText: async () => ({ output: "A joke about state machines." }),
        generateText: async () => {
          throw new Error("rater offline");
        },
      },
    });

    expect(result.status).toBe("done");
    if (result.status !== "done") throw new Error("expected done");
    expect(result.output.status).toBe("failed");
    expect(result.output.joke).toBeNull();
    expect(result.output.error).toContain("rateJoke failed");
    expect(result.output.jokes).toEqual(["A joke about state machines."]);
  });
});
