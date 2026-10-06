import { describe, expect, test } from "vitest";
import { createAgentRuntime, runToQuiescence } from "@statelyai/agent";
import type { AgentRequestExecutor, ChosenEvent } from "@statelyai/agent";
import { createMockJudge } from "../mock-judge.js";
import { JOKE_LEVELS, createRateJoke, jokeMachine } from "./index.js";

/**
 * Mock executors for one run, routed on `request.name` (the `createTextLogic`
 * name, so no prompt sniffing). `levels` is the Jev critic's `JOKE_LEVELS`
 * index per rating call (0-4 → ratings 1, 3, 6, 8, 10); the revision prompt is
 * recognised by `input.previousJoke` being set, which is exactly the machine
 * input that makes `telling` a revision pass.
 */
function createJokeExecutors(options: { levels: number[]; decision: ChosenEvent["type"] }) {
  const revisionInputs: { topic: string; previousJoke: string; rating: number | null }[] = [];
  let decideCount = 0;
  const judge = createMockJudge({ rating: options.levels });

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
      return { result: `A better joke about ${input.topic}.` };
    }
    return { result: `A joke about ${input.topic}.` };
  };

  const decide = async (): Promise<{ event: ChosenEvent }> => {
    decideCount += 1;
    return { event: { type: options.decision } };
  };

  return {
    executors: { streamText, decide },
    actors: { rateJoke: createRateJoke(judge.model) },
    jevCalls: judge.calls,
    revisionInputs,
    get decideCount() {
      return decideCount;
    },
  };
}

describe("joke-teller", () => {
  test("always takes one improvement pass, even when the first joke rates well", async () => {
    const mock = createJokeExecutors({ levels: [3, 4], decision: "END" });

    const result = await runToQuiescence(
      createAgentRuntime(jokeMachine, {
        executors: mock.executors,
        actors: mock.actors,
      }),
      {
        input: { topic: "penguins" },
      },
    );

    expect(result.status).toBe("done");
    if (result.status !== "done") throw new Error("expected done");
    expect(result.output.status).toBe("told");
    // An 8/10 first joke still gets revised: the machine owns that rule.
    expect(mock.revisionInputs).toEqual([
      { topic: "penguins", previousJoke: "A joke about penguins.", rating: 8 },
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
    expect(result.output.revisionNotice).toContain("First attempt scored 8/10");
    // The explanation is the matched rubric level, not model prose.
    expect(result.output.revisionNotice).toContain(JOKE_LEVELS[3]);
    expect(result.output.revisionNotice).toContain("improvement pass");
    expect(result.output.lastRating).toBe(10);
    expect(result.output.error).toBeNull();
  });

  test("the decision event drives the loop: TELL_ANOTHER re-tells, then the joke cap stops it", async () => {
    const mock = createJokeExecutors({ levels: [1, 1, 3], decision: "TELL_ANOTHER" });

    const result = await runToQuiescence(
      createAgentRuntime(jokeMachine, {
        executors: mock.executors,
        actors: mock.actors,
      }),
      {
        input: { topic: "state machines" },
      },
    );

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
    const mock = createJokeExecutors({ levels: [1, 3], decision: "END" });

    const result = await runToQuiescence(
      createAgentRuntime(jokeMachine, {
        executors: mock.executors,
        actors: mock.actors,
      }),
      {
        input: { topic: "state machines" },
      },
    );

    expect(result.status).toBe("done");
    if (result.status !== "done") throw new Error("expected done");
    expect(mock.decideCount).toBe(1);
    expect(result.output.status).toBe("told");
    expect(result.output.jokes).toHaveLength(2);
    expect(result.output.lastRating).toBe(8);
  });

  test("a rating failure ends in the failed final state, not a done with an empty joke", async () => {
    const result = await runToQuiescence(
      createAgentRuntime(jokeMachine, {
        executors: {
          streamText: async () => ({ result: "A joke about state machines." }),
          // Bound because the machine declares a decision state; never reached here.
          decide: async () => {
            throw new Error("unreachable");
          },
        },
        actors: {
          rateJoke: createRateJoke(
            createMockJudge({
              rating: () => {
                throw new Error("rater offline");
              },
            }).model,
          ),
        },
      }),
      {
        input: { topic: "state machines" },
      },
    );

    expect(result.status).toBe("done");
    if (result.status !== "done") throw new Error("expected done");
    expect(result.output.status).toBe("failed");
    expect(result.output.joke).toBeNull();
    expect(result.output.error).toContain("rateJoke failed");
    expect(result.output.jokes).toEqual(["A joke about state machines."]);
  });

  test("rateJoke asks Jev one five-level score over the joke and maps it to 1-10", async () => {
    const mock = createJokeExecutors({ levels: [0, 2], decision: "END" });

    const result = await runToQuiescence(
      createAgentRuntime(jokeMachine, {
        executors: mock.executors,
        actors: mock.actors,
      }),
      {
        input: { topic: "penguins" },
      },
    );

    expect(mock.jevCalls.map((call) => call.state)).toEqual([
      { joke: "A joke about penguins." },
      { joke: "A better joke about penguins." },
    ]);
    const question = mock.jevCalls[0]!.questions.rating!;
    expect(Object.keys(mock.jevCalls[0]!.questions)).toEqual(["rating"]);
    expect(question.type).toBe("score");
    expect(question.type === "score" && question.criteria).toEqual([...JOKE_LEVELS]);
    if (result.status !== "done") throw new Error("expected done");
    // Level 0 → 1/10, level 2 → 6/10.
    expect(result.output.revisionNotice).toContain("First attempt scored 1/10");
    expect(result.output.lastRating).toBe(6);
  });
});
