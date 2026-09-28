import { test } from "vitest";
import assert from "node:assert/strict";
import { createAgentRuntime, runToQuiescence } from "@statelyai/agent";
import { createMockJudge } from "../mock-judge.js";
import { createMockModelExecutors } from "../mock-model.js";
import {
  ASPECT_THRESHOLD,
  PASSING_QUALITY,
  QUALITY_LEVELS,
  aiSdkEvaluatorOptimizerMachine,
  createGradeTranslation,
  toQualityScore,
} from "./index.js";

/**
 * The grade is a Jev judgment: first pass level 2 (6/10) with nuance lost,
 * second pass level 3 (8/10) with every aspect held.
 */
function gradingJev() {
  return createMockJudge({
    quality: [2, 3],
    preservesTone: true,
    preservesNuance: [false, true],
    culturallyAccurate: true,
  });
}

test("AI SDK evaluator-optimizer maps to an explicit machine", async () => {
  const evaluated: number[] = [];
  const improved: string[] = [];
  // Routed by request name, so the two evaluate passes stay in order without
  // any of them depending on prompt wording.
  const executors = createMockModelExecutors({
    text: {
      translateText: ["Spanish:Hello friend"],
      // Only the failing grade is critiqued in prose.
      critiqueTranslation: [
        { specificIssues: ["missing nuance"], improvementSuggestions: ["add idiom"] },
      ],
      improveTranslation: ["Spanish:Hello friend improved"],
    },
  });
  const result = await runToQuiescence(
    createAgentRuntime(aiSdkEvaluatorOptimizerMachine, {
      on: {
        EVALUATED: (e) => evaluated.push(e.iteration),
        IMPROVED: (e) => improved.push(e.translation),
      },
      executors,
      actors: { gradeTranslation: createGradeTranslation(gradingJev().model) },
    }),
    {
      input: {
        text: "Hello friend",
        targetLanguage: "Spanish",
        maxIterations: 3,
      },
    },
  );
  assert.equal(result.status, "done");
  const output = result.status === "done" ? result.output : undefined;
  assert.deepEqual(output?.detail, {
    firstDraft: "Spanish:Hello friend",
    translation: "Spanish:Hello friend improved",
    evaluation: {
      qualityScore: 8,
      preservesTone: true,
      preservesNuance: true,
      culturallyAccurate: true,
      specificIssues: [],
      improvementSuggestions: [],
    },
  });
  assert.equal(output?.qualityScore, 8);
  assert.equal(output?.iterations, 2);
  // The summary leads with prose: final, first draft, and why it was revised.
  assert.ok(output?.summary.includes("Spanish:Hello friend improved"));
  assert.ok(output?.summary.includes("**First draft**"));
  assert.ok(output?.summary.includes("Score 8/10"));
  assert.ok(output?.summary.includes("Revised to fix: missing nuance"));
  // Two evaluate passes (iterations 1 then 2) with one improve step between.
  assert.deepEqual(evaluated, [1, 2]);
  assert.deepEqual(improved, ["Spanish:Hello friend improved"]);
});

test("a failed first translation lands in `failed`, not in `done` with an empty draft", async () => {
  const executors = createMockModelExecutors({
    text: {
      translateText: [
        () => {
          throw new Error("provider unavailable");
        },
      ],
    },
  });

  const result = await runToQuiescence(
    createAgentRuntime(aiSdkEvaluatorOptimizerMachine, {
      executors,
    }),
    {
      input: { text: "Hello friend", targetLanguage: "Spanish", maxIterations: 3 },
    },
  );

  assert.equal(result.status, "done");
  assert.equal(result.status === "done" ? result.snapshot.value : undefined, "failed");
  assert.equal(result.status === "done" ? result.output.detail.translation : "?", "");
});

test("the grade asks Jev one score and three boolean questions in one call; thresholds decide the loop", async () => {
  assert.equal(toQualityScore(0), 1);
  assert.equal(toQualityScore(QUALITY_LEVELS.length - 1), 10);
  assert.equal(toQualityScore(3), PASSING_QUALITY);

  // Top quality, but nuance just under the aspect threshold: not a pass.
  const jev = createMockJudge({
    quality: 4,
    preservesTone: ASPECT_THRESHOLD,
    preservesNuance: [ASPECT_THRESHOLD - 0.01, ASPECT_THRESHOLD],
    culturallyAccurate: true,
  });
  const requests: string[] = [];
  const mock = createMockModelExecutors({
    text: {
      translateText: ["draft"],
      critiqueTranslation: [{ specificIssues: ["calque"], improvementSuggestions: ["use idiom"] }],
      improveTranslation: ["revised"],
    },
  });
  const result = await runToQuiescence(
    createAgentRuntime(aiSdkEvaluatorOptimizerMachine, {
      executors: {
        ...mock,
        generateText: async (request, info) => {
          requests.push(request.name ?? request.model);
          return mock.generateText(request, info);
        },
      },
      actors: { gradeTranslation: createGradeTranslation(jev.model) },
    }),
    {
      input: { text: "Break a leg!", targetLanguage: "French", maxIterations: 3 },
    },
  );

  assert.equal(jev.calls.length, 2);
  const call = jev.calls[0]!;
  assert.deepEqual(call.state, {
    original: "Break a leg!",
    translation: "draft",
    targetLanguage: "French",
  });
  assert.deepEqual(
    Object.fromEntries(Object.entries(call.questions).map(([name, q]) => [name, q.type])),
    {
      quality: "score",
      preservesTone: "boolean",
      preservesNuance: "boolean",
      culturallyAccurate: "boolean",
    },
  );
  // Failed once (critique + improve), then passed exactly at the threshold.
  assert.deepEqual(requests, ["translateText", "critiqueTranslation", "improveTranslation"]);
  assert.equal(result.status === "done" ? result.output.qualityScore : 0, 10);
  assert.equal(result.status === "done" ? result.output.iterations : 0, 2);
});
