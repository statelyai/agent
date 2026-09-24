import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { type AgentTextRequest } from "@statelyai/agent";
import { lintAgentMachine } from "@statelyai/agent/testing";
import { createMockModelExecutors, type MockModelScript } from "../mock-model.js";
import { MAX_JUDGE_RETRIES, MAX_SUBJECTS, mapReduceMachine, runMapReduceExample } from "./index.js";

/**
 * Only the model is mocked, keyed by request name: `generateSubjects`,
 * `writeJoke` (one call per spawned branch), and `judgeJokes`.
 */
function scripted(text: MockModelScript["text"]) {
  const executors = createMockModelExecutors({ text });
  return { generateText: executors.generateText, calls: executors.calls };
}

/** State path with consecutive repeats (context-only updates) collapsed. */
const path = (progress: string[]) => progress.filter((state, i) => state !== progress[i - 1]);

/** A joke that names its subject, so assertions can tell branches apart. */
const jokeAbout = (request: AgentTextRequest) => ({
  joke: `A joke about ${(request.input as { subject: string }).subject}.`,
});

test("happy path: fan out one joke per subject, judge picks one", async () => {
  const executors = scripted({
    generateSubjects: [{ subjects: ["lions", "penguins", "owls"] }],
    writeJoke: jokeAbout,
    judgeJokes: [{ bestIndex: 1 }],
  });
  const result = await runMapReduceExample({ topic: "animals", ...executors });

  expect(result.outcome).toBe("done");
  expect(path(result.progress)).toEqual([
    "generatingSubjects",
    "generatingJokes",
    "judging",
    "done",
  ]);
  // One writeJoke call per subject, all three spawned from one state.
  expect(executors.calls.filter((call) => call.name === "writeJoke")).toHaveLength(3);
  expect(result.jokes.map((entry) => entry.subject).sort()).toEqual(["lions", "owls", "penguins"]);
  for (const entry of result.jokes) expect(entry.joke).toBe(`A joke about ${entry.subject}.`);
  expect(result.bestJoke).toBe(result.jokes[1]!.joke);
  expect(result.subject).toBe(result.jokes[1]!.subject);
  expect(result.trail.at(-1)).toBe("The judge picked joke [1].");
});

test("more than MAX_SUBJECTS subjects are truncated", async () => {
  const executors = scripted({
    generateSubjects: [{ subjects: ["a", "b", "c", "d", "e", "f"] }],
    writeJoke: jokeAbout,
    judgeJokes: [{ bestIndex: 0 }],
  });
  const result = await runMapReduceExample({ ...executors });

  expect(result.outcome).toBe("done");
  expect(executors.calls.filter((call) => call.name === "writeJoke")).toHaveLength(MAX_SUBJECTS);
  expect(result.jokes).toHaveLength(MAX_SUBJECTS);
  expect(result.trail[0]).toBe(`Subjects: a, b, c, d (truncated to ${MAX_SUBJECTS})`);
});

test("zero subjects land in failed", async () => {
  const executors = scripted({ generateSubjects: [{ subjects: [] }] });
  const result = await runMapReduceExample({ ...executors });

  expect(result.outcome).toBe("failed");
  expect(result.progress).toEqual(["generatingSubjects", "failed"]);
  expect(result.bestJoke).toBe("No best joke: The model listed no subjects.");
  expect(executors.calls.some((call) => call.name === "writeJoke")).toBe(false);
});

test("a failing branch records a placeholder joke and the run continues", async () => {
  const executors = scripted({
    generateSubjects: [{ subjects: ["lions", "penguins"] }],
    writeJoke: (request: AgentTextRequest) => {
      if ((request.input as { subject: string }).subject === "penguins") {
        throw new Error("provider unavailable");
      }
      return jokeAbout(request);
    },
    judgeJokes: [{ bestIndex: 0 }],
  });
  const result = await runMapReduceExample({ ...executors });

  expect(result.outcome).toBe("done");
  expect(result.jokes).toHaveLength(2);
  expect(result.jokes).toContainEqual({
    subject: "penguins",
    joke: '[no joke: the writer for "penguins" failed]',
  });
  expect(result.jokes).toContainEqual({ subject: "lions", joke: "A joke about lions." });
});

test("an out-of-range index is retried once", async () => {
  const executors = scripted({
    generateSubjects: [{ subjects: ["lions", "penguins"] }],
    writeJoke: jokeAbout,
    judgeJokes: [{ bestIndex: 7 }, { bestIndex: 0 }],
  });
  const result = await runMapReduceExample({ ...executors });

  expect(result.outcome).toBe("done");
  // The retry re-enters `judging` through the choice state.
  expect(result.progress.slice(-3)).toEqual(["judging", "judging", "done"]);
  expect(executors.calls.filter((call) => call.name === "judgeJokes")).toHaveLength(2);
  expect(result.bestJoke).toBe(result.jokes[0]!.joke);
});

test("a fractional index is rejected like an out-of-range one", async () => {
  const executors = scripted({
    generateSubjects: [{ subjects: ["lions", "penguins"] }],
    writeJoke: jokeAbout,
    judgeJokes: [{ bestIndex: 0.5 }, { bestIndex: 1 }],
  });
  const result = await runMapReduceExample({ ...executors });

  expect(result.outcome).toBe("done");
  expect(executors.calls.filter((call) => call.name === "judgeJokes")).toHaveLength(2);
  expect(result.bestJoke).toBe(result.jokes[1]!.joke);
});

test("an index still out of range after MAX_JUDGE_RETRIES lands in failed", async () => {
  const executors = scripted({
    generateSubjects: [{ subjects: ["lions", "penguins"] }],
    writeJoke: jokeAbout,
    judgeJokes: [{ bestIndex: 3 }],
  });
  const result = await runMapReduceExample({ ...executors });

  expect(result.outcome).toBe("failed");
  expect(executors.calls.filter((call) => call.name === "judgeJokes")).toHaveLength(
    1 + MAX_JUDGE_RETRIES,
  );
  expect(result.bestJoke).toContain("The judge picked index 3 of 2 jokes");
  // Best effort: every joke that landed is still in the output.
  expect(result.jokes).toHaveLength(2);
});

test("starters behave as their labels advertise", async () => {
  const starters = JSON.parse(readFileSync(new URL("./metadata.json", import.meta.url), "utf8"))
    .starters as string[];
  expect(starters).toHaveLength(3);

  for (const topic of starters) {
    const executors = scripted({
      generateSubjects: (request: AgentTextRequest) => ({
        subjects: [`${(request.input as { topic: string }).topic} one`, "two", "three"],
      }),
      writeJoke: jokeAbout,
      judgeJokes: [{ bestIndex: 2 }],
    });
    const result = await runMapReduceExample({ topic, ...executors });
    expect(result.outcome).toBe("done");
    expect(result.jokes).toHaveLength(3);
    expect(result.trail[0]).toContain(topic);
  }
});

test("lint is clean", () => {
  expect(() => lintAgentMachine(mapReduceMachine, { throw: true })).not.toThrow();
});
