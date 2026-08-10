import { test } from "vitest";
import assert from "node:assert/strict";
import { runAgent } from "@statelyai/agent";
import { aiSdkEvaluatorOptimizerMachine } from "./index.js";

test("AI SDK evaluator-optimizer maps to an explicit machine", async () => {
  let evaluations = 0;
  const evaluated: number[] = [];
  const improved: string[] = [];
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
    executors: {
      generateText: async (request) => {
        if (request.prompt?.startsWith("Translate this text to Spanish:")) {
          return { output: "Spanish:Hello friend" };
        }
        if (request.prompt?.includes("Suggestions:")) {
          return { output: "Spanish:Hello friend improved" };
        }
        evaluations += 1;
        return evaluations === 1
          ? {
              output: {
                qualityScore: 6,
                preservesTone: true,
                preservesNuance: false,
                culturallyAccurate: true,
                specificIssues: ["missing nuance"],
                improvementSuggestions: ["add idiom"],
              },
            }
          : {
              output: {
                qualityScore: 9,
                preservesTone: true,
                preservesNuance: true,
                culturallyAccurate: true,
                specificIssues: [],
                improvementSuggestions: [],
              },
            };
      },
    },
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
