import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { lintAgentMachine } from "@statelyai/agent/testing";
import { createMockModelExecutors, type MockModelScript } from "../mock-model.js";
import {
  MAX_REGENERATIONS,
  hasPunchline,
  promptChainingMachine,
  runPromptChainingExample,
} from "./index.js";

/** Only the model is mocked, keyed by request name. */
function scripted(text: MockModelScript["text"]) {
  const executors = createMockModelExecutors({ text });
  return { generateText: executors.generateText, calls: executors.calls };
}

const chain = {
  improveJoke: [{ joke: "Why did the cat sit on the laptop? To keep an eye on the mouse!" }],
  polishJoke: [{ joke: "Why did the cat sit on the laptop? It was the mouse's landlord!" }],
};

test("the gate is the tutorial's check", () => {
  expect(hasPunchline("Why?")).toBe(true);
  expect(hasPunchline("Ha!")).toBe(true);
  expect(hasPunchline("A cat walks into a bar.")).toBe(false);
});

test("happy path: punchline passes, then improve and polish", async () => {
  const executors = scripted({
    generateJoke: [{ joke: "Why did the cat sit on the laptop? For the mouse." }],
    ...chain,
  });
  const result = await runPromptChainingExample({ ...executors });

  expect(result.outcome).toBe("done");
  expect(result.progress).toEqual(["generating", "improving", "polishing", "done"]);
  expect(result.stage).toBe("polished");
  expect(result.regenerations).toBe(0);
  expect(result.joke).toBe(chain.polishJoke[0]!.joke);
  // Each step works on the previous step's output.
  expect(executors.calls.find((call) => call.name === "polishJoke")?.input).toEqual({
    joke: chain.improveJoke[0]!.joke,
  });
});

test("a failed check regenerates, and a later pass continues the chain", async () => {
  const executors = scripted({
    generateJoke: [{ joke: "A cat sat on a laptop." }, { joke: "Guess who sat on the laptop?" }],
    ...chain,
  });
  const result = await runPromptChainingExample({ ...executors });

  expect(result.outcome).toBe("done");
  expect(result.progress).toEqual(["generating", "regenerating", "improving", "polishing", "done"]);
  expect(result.regenerations).toBe(1);
  // The regeneration sees the joke that failed.
  expect(executors.calls.filter((call) => call.name === "generateJoke")[1]?.input).toEqual({
    topic: "cats",
    previousJoke: "A cat sat on a laptop.",
  });
});

test("regenerations exhausted: failed with the last joke", async () => {
  const executors = scripted({ generateJoke: [{ joke: "A cat sat on a laptop." }] });
  const result = await runPromptChainingExample({ ...executors });

  expect(result.outcome).toBe("failed");
  expect(result.progress).toEqual(["generating", "regenerating", "regenerating", "failed"]);
  expect(result.regenerations).toBe(MAX_REGENERATIONS);
  expect(result.stage).toBe("generated");
  expect(result.joke).toBe("A cat sat on a laptop.");
  expect(result.trail.at(-1)).toContain(`No punchline after ${MAX_REGENERATIONS} regenerations`);
  expect(executors.calls.some((call) => call.name === "improveJoke")).toBe(false);
});

test("a mid-chain error fails with the best joke so far", async () => {
  const executors = scripted({
    generateJoke: [{ joke: "Why did the cat sit on the laptop?" }],
    improveJoke: chain.improveJoke,
    polishJoke: () => {
      throw new Error("provider unavailable");
    },
  });
  const result = await runPromptChainingExample({ ...executors });

  expect(result.outcome).toBe("failed");
  expect(result.stage).toBe("improved");
  expect(result.joke).toBe(chain.improveJoke[0]!.joke);
  expect(result.trail.at(-1)).toContain("polishJoke failed");
});

test("starters behave as their labels advertise", async () => {
  const starters = JSON.parse(readFileSync(new URL("./metadata.json", import.meta.url), "utf8"))
    .starters as string[];
  expect(starters).toHaveLength(3);

  for (const topic of starters) {
    const result = await runPromptChainingExample({
      topic,
      ...scripted({ generateJoke: [{ joke: `What about ${topic}?` }], ...chain }),
    });
    expect(result.outcome).toBe("done");
  }
});

test("lint is clean", () => {
  expect(() => lintAgentMachine(promptChainingMachine, { throw: true })).not.toThrow();
});
