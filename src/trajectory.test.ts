import { describe, expect, test } from "vitest";
import { matchesTrajectory, runAgent, createScriptedExecutors, setupAgent } from "./index.js";
import type { AgentLogEntry } from "./index.js";
import { z } from "zod";

const entry = (type: string, payload: Record<string, unknown> = {}): AgentLogEntry =>
  ({
    schemaVersion: 1,
    id: type,
    index: 0,
    recordedAt: "2026-01-01T00:00:00.000Z",
    machineId: "m",
    machineVersion: "1",
    event: { type, ...payload },
  }) as unknown as AgentLogEntry;

describe("matchesTrajectory: state paths", () => {
  test("ordered subsequence with gaps allowed", () => {
    const actual = ["prompting", "evaluating", "needsMoreInfo", "drafting", "sent"];

    expect(matchesTrajectory(actual, ["prompting", "drafting", "sent"])).toEqual({
      matched: true,
      matchedCount: 3,
      expectedCount: 3,
      score: 1,
    });
  });

  test("out-of-order expectations miss, and the miss says where the search stopped", () => {
    const actual = ["prompting", "drafting", "sent"];

    const result = matchesTrajectory(actual, ["drafting", "prompting"]);

    expect(result.matched).toBe(false);
    expect(result.matchedCount).toBe(1);
    expect(result.score).toBe(0.5);
    // `drafting` consumed index 1, so `prompting` was only searched for from 2.
    expect(result.firstMiss).toEqual({ index: 1, expected: "prompting", searchedFrom: 2 });
  });

  test("repeated expectations need repeated occurrences", () => {
    expect(matchesTrajectory(["a", "b", "a"], ["a", "a"]).matched).toBe(true);
    expect(matchesTrajectory(["a", "b"], ["a", "a"]).matched).toBe(false);
  });
});

describe("matchesTrajectory: nested state values", () => {
  test("nested objects compare structurally", () => {
    const actual = [{ review: "editing" }, { review: "approving" }];

    expect(matchesTrajectory(actual, [{ review: "editing" }]).matched).toBe(true);
    expect(matchesTrajectory(actual, [{ review: "rejecting" }]).matched).toBe(false);
  });

  test("a string expectation is a dot path into a nested value", () => {
    const actual = [{ review: { pane: "editing" } }];

    expect(matchesTrajectory(actual, ["review.pane.editing"]).matched).toBe(true);
    // An ancestor matches too: "it was somewhere in `review`".
    expect(matchesTrajectory(actual, ["review"]).matched).toBe(true);
    expect(matchesTrajectory(actual, ["review.pane.saving"]).matched).toBe(false);
  });

  test("parallel regions expose every leaf", () => {
    const actual = [{ editor: "typing", saver: "idle" }];

    expect(matchesTrajectory(actual, ["saver.idle"]).matched).toBe(true);
    expect(matchesTrajectory(actual, [{ editor: "typing" }]).matched).toBe(false);
  });

  test("snapshots are unwrapped to their value", () => {
    const actual = [
      { value: "prompting", status: "active" },
      { value: { review: "editing" }, status: "active" },
    ];

    expect(matchesTrajectory(actual, ["prompting", "review.editing"]).matched).toBe(true);
  });
});

describe("matchesTrajectory: events", () => {
  test("log entries match by event type", () => {
    const actual = [
      entry("@agent.init"),
      entry("PROMPT_SUBMITTED"),
      entry("xstate.done.0"),
      entry("SEND"),
    ];

    expect(matchesTrajectory(actual, ["PROMPT_SUBMITTED", "SEND"]).matched).toBe(true);
    expect(matchesTrajectory(actual, ["SEND", "PROMPT_SUBMITTED"]).matched).toBe(false);
  });

  test("an event object also matches its declared payload keys, and ignores the rest", () => {
    const actual = [entry("MORE_INFO", { details: "Send it to team@example.com.", at: 7 })];

    expect(
      matchesTrajectory(actual, [{ type: "MORE_INFO", details: "Send it to team@example.com." }])
        .matched,
    ).toBe(true);
    expect(matchesTrajectory(actual, [{ type: "MORE_INFO", details: "other" }]).matched).toBe(
      false,
    );
  });

  test("bare event objects and log entries are interchangeable", () => {
    expect(matchesTrajectory([{ type: "SEND" }], [entry("SEND")]).matched).toBe(true);
  });

  test("events and state values never cross-match", () => {
    expect(matchesTrajectory([{ type: "SEND" }], [{ review: "editing" }]).matched).toBe(false);
    expect(matchesTrajectory([{ review: "editing" }], [{ type: "SEND" }]).matched).toBe(false);
  });
});

describe("matchesTrajectory: exact mode", () => {
  test("requires the same items in the same positions", () => {
    const actual = ["prompting", "drafting", "sent"];

    expect(matchesTrajectory(actual, actual, { exact: true }).matched).toBe(true);
    expect(matchesTrajectory(actual, ["prompting", "sent"], { exact: true }).matched).toBe(false);
  });

  test("extra actual items fail, and score against the longer side", () => {
    const result = matchesTrajectory(["a", "b", "c"], ["a", "b"], { exact: true });

    expect(result.matched).toBe(false);
    expect(result.matchedCount).toBe(2);
    expect(result.score).toBeCloseTo(2 / 3);
    expect(result.firstMiss).toBeUndefined();
  });

  test("a divergence reports its position", () => {
    const result = matchesTrajectory(["a", "x", "c"], ["a", "b", "c"], { exact: true });

    expect(result.firstMiss).toEqual({ index: 1, expected: "b", searchedFrom: 1 });
    expect(result.score).toBeCloseTo(1 / 3);
  });
});

describe("matchesTrajectory: partial credit and degenerate cases", () => {
  test("score is the matched fraction of the expectation", () => {
    const result = matchesTrajectory(
      ["prompting", "drafting"],
      ["prompting", "drafting", "reviewing", "sent"],
    );

    expect(result.matched).toBe(false);
    expect(result.matchedCount).toBe(2);
    expect(result.expectedCount).toBe(4);
    expect(result.score).toBe(0.5);
    expect(result.firstMiss).toEqual({ index: 2, expected: "reviewing", searchedFrom: 2 });
  });

  test("an empty expectation always matches", () => {
    expect(matchesTrajectory(["a"], [])).toEqual({
      matched: true,
      matchedCount: 0,
      expectedCount: 0,
      score: 1,
    });
    expect(matchesTrajectory([], [], { exact: true }).matched).toBe(true);
    expect(matchesTrajectory(["a"], [], { exact: true })).toMatchObject({
      matched: false,
      score: 0,
    });
  });

  test("an empty run misses the first expected item", () => {
    const result = matchesTrajectory([], ["prompting"]);

    expect(result).toEqual({
      matched: false,
      matchedCount: 0,
      expectedCount: 1,
      score: 0,
      firstMiss: { index: 0, expected: "prompting", searchedFrom: 0 },
    });
  });

  test("the result is JSON-safe, so a scorer can attach it as metadata", () => {
    const result = matchesTrajectory(["a"], ["b"]);

    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });
});

describe("matchesTrajectory: over a real run", () => {
  const setup = setupAgent({
    context: z.object({ topic: z.string(), joke: z.string() }),
    input: z.object({ topic: z.string() }),
    output: z.object({ joke: z.string() }),
    requests: {
      tellJoke: {
        schemas: { input: z.object({ topic: z.string() }), output: z.string() },
        model: "jokester",
        prompt: ({ input }) => `Joke about ${input.topic}`,
      },
    },
  });

  const jokeMachine = setup.createMachine({
    id: "joke",
    context: ({ input }) => ({ topic: input.topic, joke: "" }),
    output: ({ context }) => ({ joke: context.joke }),
    initial: "telling",
    states: {
      telling: {
        invoke: {
          src: "tellJoke",
          input: ({ context }) => ({ topic: context.topic }),
          onDone: ({ output }) => ({ target: "told", context: { joke: output } }),
        },
      },
      told: { type: "final" },
    },
  });

  test("scores the state path and the event log with the same call", async () => {
    const statePath: unknown[] = [];

    const result = await runAgent(jokeMachine, {
      input: { topic: "state machines" },
      executors: createScriptedExecutors({ text: ["A joke."] }),
      onTransition: (snapshot) => statePath.push(snapshot.value),
    });

    expect(matchesTrajectory(statePath, ["telling", "told"]).matched).toBe(true);
    expect(matchesTrajectory(result.events, ["@agent.init"]).matched).toBe(true);
    expect(matchesTrajectory(result.events, ["told"]).matched).toBe(false);
  });
});
