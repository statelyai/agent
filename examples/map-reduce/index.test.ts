import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { type AgentTextRequest } from "@statelyai/agent";
import { lintAgentMachine } from "@statelyai/agent/testing";
import { createMockJevClient } from "../mock-jev.js";
import { createMockModelExecutors, type MockModelScript } from "../mock-model.js";
import { MAX_JUDGE_RETRIES, MAX_SUBJECTS, mapReduceMachine, runMapReduceExample } from "./index.js";

/**
 * Only the models are mocked. The text model is keyed by request name:
 * `generateSubjects` and `writeJoke` (one call per spawned branch). The judge
 * is a Jev `choice` named `best`, answered with a joke label (`joke0`, …).
 */
function scripted(text: MockModelScript["text"], best: string | string[] = "joke0") {
  const executors = createMockModelExecutors({ text });
  const jev = createMockJevClient({ best });
  return {
    generateText: executors.generateText,
    calls: executors.calls,
    jevClient: jev.client,
    jev,
  };
}

/**
 * A judge that answers labels the machine never offered. The mock client
 * refuses those, so this is a bare `TypeSafeClient` over a scripted `fetch`:
 * it stands in for a swapped-in judge the choice state has to guard against.
 */
function offListJudge(picks: string[]) {
  let sent = 0;
  const client = new TypeSafeClient({
    apiKey: "test-key",
    retry: { maxRetries: 0 },
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { model: string };
      const pick = picks[Math.min(sent++, picks.length - 1)]!;
      return Response.json({
        model: body.model,
        answers: {
          best: { type: "choice", choice: pick, confidence: 0.9, probabilities: { [pick]: 0.9 } },
        },
        usage: { input_tokens: 0, output_tokens: 0 },
      });
    },
  });
  return { client, calls: () => sent };
}

/** State path with consecutive repeats (context-only updates) collapsed. */
const path = (progress: string[]) => progress.filter((state, i) => state !== progress[i - 1]);

/** A joke that names its subject, so assertions can tell branches apart. */
const jokeAbout = (request: AgentTextRequest) => ({
  joke: `A joke about ${(request.input as { subject: string }).subject}.`,
});

test("happy path: fan out one joke per subject, judge picks one", async () => {
  const executors = scripted(
    {
      generateSubjects: [{ subjects: ["lions", "penguins", "owls"] }],
      writeJoke: jokeAbout,
    },
    "joke1",
  );
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

test("an out-of-range label is retried once", async () => {
  const judge = offListJudge(["joke7", "joke0"]);
  const result = await runMapReduceExample({
    ...scripted({ generateSubjects: [{ subjects: ["lions", "penguins"] }], writeJoke: jokeAbout }),
    jevClient: judge.client,
  });

  expect(result.outcome).toBe("done");
  // The retry re-enters `judging` through the choice state.
  expect(result.progress.slice(-3)).toEqual(["judging", "judging", "done"]);
  expect(judge.calls()).toBe(2);
  expect(result.bestJoke).toBe(result.jokes[0]!.joke);
});

test("a label that names no joke is rejected like an out-of-range one", async () => {
  const judge = offListJudge(["joke0.5", "joke1"]);
  const result = await runMapReduceExample({
    ...scripted({ generateSubjects: [{ subjects: ["lions", "penguins"] }], writeJoke: jokeAbout }),
    jevClient: judge.client,
  });

  expect(result.outcome).toBe("done");
  expect(judge.calls()).toBe(2);
  expect(result.bestJoke).toBe(result.jokes[1]!.joke);
});

test("a label still out of range after MAX_JUDGE_RETRIES lands in failed", async () => {
  const judge = offListJudge(["joke3"]);
  const result = await runMapReduceExample({
    ...scripted({ generateSubjects: [{ subjects: ["lions", "penguins"] }], writeJoke: jokeAbout }),
    jevClient: judge.client,
  });

  expect(result.outcome).toBe("failed");
  expect(judge.calls()).toBe(1 + MAX_JUDGE_RETRIES);
  expect(result.bestJoke).toContain("The judge picked index 3 of 2 jokes");
  // Best effort: every joke that landed is still in the output.
  expect(result.jokes).toHaveLength(2);
});

test("starters behave as their labels advertise", async () => {
  const starters = JSON.parse(readFileSync(new URL("./metadata.json", import.meta.url), "utf8"))
    .starters as string[];
  expect(starters).toHaveLength(3);

  for (const topic of starters) {
    const executors = scripted(
      {
        generateSubjects: (request: AgentTextRequest) => ({
          subjects: [`${(request.input as { topic: string }).topic} one`, "two", "three"],
        }),
        writeJoke: jokeAbout,
      },
      "joke2",
    );
    const result = await runMapReduceExample({ topic, ...executors });
    expect(result.outcome).toBe("done");
    expect(result.jokes).toHaveLength(3);
    expect(result.trail[0]).toContain(topic);
  }
});

test("a single landed joke skips judging: index 0, zero Jev calls", async () => {
  const executors = scripted({ generateSubjects: [{ subjects: ["lions"] }], writeJoke: jokeAbout });
  const result = await runMapReduceExample({ ...executors });

  expect(result.outcome).toBe("done");
  expect(path(result.progress)).toEqual(["generatingSubjects", "generatingJokes", "done"]);
  expect(executors.jev.calls).toHaveLength(0);
  expect(result.bestJoke).toBe("A joke about lions.");
  expect(result.subject).toBe("lions");
  expect(result.trail.at(-1)).toBe("Only one joke; no judging needed.");
});

test("the judge asks Jev one choice over the jokes, one label per joke", async () => {
  const executors = scripted(
    { generateSubjects: [{ subjects: ["lions", "penguins", "owls"] }], writeJoke: jokeAbout },
    "joke2",
  );
  const result = await runMapReduceExample({ topic: "animals", ...executors });

  expect(executors.jev.calls).toHaveLength(1);
  const call = executors.jev.calls[0]!;
  // The evidence is the state: the topic and every landed joke with its subject.
  expect(call.state).toEqual({ topic: "animals", jokes: result.jokes });
  expect(Object.keys(call.questions)).toEqual(["best"]);
  const best = call.questions.best!;
  expect(best.type).toBe("choice");
  // Labels are the jokes themselves, so Jev cannot name one that did not land.
  expect(Object.keys((best as { criteria: object }).criteria)).toEqual(["joke0", "joke1", "joke2"]);
  expect(result.bestJoke).toBe(result.jokes[2]!.joke);
});

test("lint is clean", () => {
  expect(() => lintAgentMachine(mapReduceMachine, { throw: true })).not.toThrow();
});
