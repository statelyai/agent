import { test } from "vitest";
import assert from "node:assert/strict";
import { createScriptedExecutors, runAgent } from "@statelyai/agent";
import { aiSdkEvaluatorOptimizerMachine } from "./index.js";

test("AI SDK evaluator-optimizer maps to an explicit machine", async () => {
  const evaluated: number[] = [];
  const improved: string[] = [];
  // Routed by request name, so the two evaluate passes stay in order without
  // any of them depending on prompt wording.
  const executors = createScriptedExecutors({
    text: {
      translateText: ["Spanish:Hello friend"],
      evaluateTranslation: [
        {
          qualityScore: 6,
          preservesTone: true,
          preservesNuance: false,
          culturallyAccurate: true,
          specificIssues: ["missing nuance"],
          improvementSuggestions: ["add idiom"],
        },
        {
          qualityScore: 9,
          preservesTone: true,
          preservesNuance: true,
          culturallyAccurate: true,
          specificIssues: [],
          improvementSuggestions: [],
        },
      ],
      improveTranslation: ["Spanish:Hello friend improved"],
    },
  });
  const result = await runAgent(aiSdkEvaluatorOptimizerMachine, {
    input: {
      text: "Hello friend",
      targetLanguage: "Spanish",
      maxIterations: 3,
    },
    on: {
      EVALUATED: (e) => evaluated.push(e.iteration),
      IMPROVED: (e) => improved.push(e.translation),
    },
    executors,
  });
  assert.equal(result.status, "done");
  const output = result.status === "done" ? result.output : undefined;
  assert.deepEqual(output?.detail, {
    firstDraft: "Spanish:Hello friend",
    translation: "Spanish:Hello friend improved",
    evaluation: {
      qualityScore: 9,
      preservesTone: true,
      preservesNuance: true,
      culturallyAccurate: true,
      specificIssues: [],
      improvementSuggestions: [],
    },
  });
  assert.equal(output?.qualityScore, 9);
  assert.equal(output?.iterations, 2);
  // The summary leads with prose: final, first draft, and why it was revised.
  assert.ok(output?.summary.includes("Spanish:Hello friend improved"));
  assert.ok(output?.summary.includes("**First draft**"));
  assert.ok(output?.summary.includes("Score 9/10"));
  assert.ok(output?.summary.includes("Revised to fix: missing nuance"));
  // Two evaluate passes (iterations 1 then 2) with one improve step between.
  assert.deepEqual(evaluated, [1, 2]);
  assert.deepEqual(improved, ["Spanish:Hello friend improved"]);
});

test("a failed first translation lands in `failed`, not in `done` with an empty draft", async () => {
  const executors = createScriptedExecutors({
    text: {
      translateText: [
        () => {
          throw new Error("provider unavailable");
        },
      ],
    },
  });

  const result = await runAgent(aiSdkEvaluatorOptimizerMachine, {
    input: { text: "Hello friend", targetLanguage: "Spanish", maxIterations: 3 },
    executors,
  });

  assert.equal(result.status, "done");
  assert.equal(result.status === "done" ? result.snapshot.value : undefined, "failed");
  assert.equal(result.status === "done" ? result.output.detail.translation : "?", "");
});
