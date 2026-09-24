import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { lintAgentMachine } from "@statelyai/agent/testing";
import { createMockModelExecutors } from "../mock-model.js";
import {
  RELEVANCE_THRESHOLD,
  WEIGHTS,
  essayGraderMachine,
  runEssayGraderExample,
} from "./index.js";

/** Mock only the model, keyed by REQUEST NAME. */
function scripted(text: Record<string, unknown[]>) {
  return createMockModelExecutors({ text }).generateText;
}

const grade = (score: number) => ({ score, comment: `scored ${score}` });

test("every gate passes → all four passes run → weighted score", async () => {
  const result = await runEssayGraderExample({
    generateText: scripted({
      checkRelevance: [grade(0.9)],
      checkGrammar: [grade(0.8)],
      analyzeStructure: [grade(0.8)],
      evaluateDepth: [grade(0.7)],
    }),
  });

  expect(result.finalState).toBe("scoring");
  expect(result.stage).toBe("all four stages ran");
  expect(result.finalScore).toBeCloseTo(0.9 * 0.3 + 0.8 * 0.2 + 0.8 * 0.2 + 0.7 * 0.3);
  expect(result.scores).toEqual({ relevance: 0.9, grammar: 0.8, structure: 0.8, depth: 0.7 });
  expect(result.report).toMatch(/^Final score 0\.8 \(all four stages ran\)\./);
  expect(result.progress).toEqual([
    "checkingRelevance",
    "checkingGrammar",
    "analyzingStructure",
    "evaluatingDepth",
    "scoring",
  ]);
});

test("low relevance → early exit after the first pass", async () => {
  const result = await runEssayGraderExample({
    generateText: scripted({ checkRelevance: [grade(0.2)] }),
  });

  expect(result.finalState).toBe("scoring");
  expect(result.stage).toBe("stopped after relevance");
  expect(result.finalScore).toBeCloseTo(0.2 * WEIGHTS.relevance);
  expect(result.scores).toEqual({ relevance: 0.2, grammar: null, structure: null, depth: null });
  expect(result.report).toContain("- grammar: not graded");
  expect(result.progress).toEqual(["checkingRelevance", "scoring"]);
});

test("a score exactly at the threshold does not pass the gate", async () => {
  const result = await runEssayGraderExample({
    generateText: scripted({ checkRelevance: [grade(RELEVANCE_THRESHOLD)] }),
  });
  expect(result.stage).toBe("stopped after relevance");
});

test("low grammar → early exit after the second pass", async () => {
  const result = await runEssayGraderExample({
    generateText: scripted({ checkRelevance: [grade(0.9)], checkGrammar: [grade(0.4)] }),
  });

  expect(result.stage).toBe("stopped after grammar");
  expect(result.scores.structure).toBeNull();
  expect(result.progress).toEqual(["checkingRelevance", "checkingGrammar", "scoring"]);
});

test("weak structure → early exit after the third pass", async () => {
  const result = await runEssayGraderExample({
    generateText: scripted({
      checkRelevance: [grade(0.9)],
      checkGrammar: [grade(0.9)],
      analyzeStructure: [grade(0.5)],
    }),
  });

  expect(result.stage).toBe("stopped after structure");
  expect(result.scores.depth).toBeNull();
  expect(result.progress).toEqual([
    "checkingRelevance",
    "checkingGrammar",
    "analyzingStructure",
    "scoring",
  ]);
});

test("a failing grading call lands in failed with the scores gathered so far", async () => {
  // checkGrammar has no scripted answer, so the executor throws.
  const result = await runEssayGraderExample({
    generateText: scripted({ checkRelevance: [grade(0.9)] }),
  });

  expect(result.finalState).toBe("failed");
  expect(result.stage).toBe("stopped after relevance");
  expect(result.scores.relevance).toBe(0.9);
  expect(result.report).toMatch(/^Grading failed; partial score/);
});

test("an out-of-range score fails validation → failed", async () => {
  const result = await runEssayGraderExample({
    generateText: scripted({ checkRelevance: [{ score: 7, comment: "out of ten" }] }),
  });
  expect(result.finalState).toBe("failed");
  expect(result.stage).toBe("no stage completed");
});

test("machine lints clean", () => {
  expect(() => lintAgentMachine(essayGraderMachine, { throw: true })).not.toThrow();
});

const starters = JSON.parse(readFileSync(new URL("./metadata.json", import.meta.url), "utf8"))
  .starters as string[];

test("starters behave as their labels advertise", async () => {
  // The starters ARE the essays: a strong one, an off-topic one, a sloppy one.
  // Graded the way their text reads, each takes a different exit.
  const [good, offTopic, sloppy] = starters;
  const byEssay = new Map([
    [good!, { relevance: 0.9, grammar: 0.9, structure: 0.8, depth: 0.8 }],
    [offTopic!, { relevance: 0.1, grammar: 0.9, structure: 0.1, depth: 0.1 }],
    [sloppy!, { relevance: 0.8, grammar: 0.3, structure: 0.5, depth: 0.4 }],
  ]);
  const gradeFor = (key: "relevance" | "grammar" | "structure" | "depth") => [
    (request: { prompt?: string }) => {
      const essay = [...byEssay.keys()].find((text) => request.prompt?.includes(text))!;
      return grade(byEssay.get(essay)![key]);
    },
  ];
  const generateText = scripted({
    checkRelevance: gradeFor("relevance"),
    checkGrammar: gradeFor("grammar"),
    analyzeStructure: gradeFor("structure"),
    evaluateDepth: gradeFor("depth"),
  });

  const stages = [];
  for (const essay of starters) {
    stages.push((await runEssayGraderExample({ essay, generateText })).stage);
  }
  expect(stages).toEqual([
    "all four stages ran",
    "stopped after relevance",
    "stopped after grammar",
  ]);
});
