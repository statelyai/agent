import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { lintAgentMachine } from "@statelyai/agent/testing";
import { createMockJudge, type MockJudgeEntry } from "../mock-judge.js";
import {
  RELEVANCE_THRESHOLD,
  RUBRICS,
  STRUCTURE_THRESHOLD,
  WEIGHTS,
  essayGraderMachine,
  runEssayGraderExample,
} from "./index.js";

/**
 * Mock only the judge, keyed by QUESTION NAME (the criterion). Answers are rubric
 * level indexes 0-4, which the machine maps to 0, 0.25, 0.5, 0.75, 1.
 */
function scripted(levels: Record<string, MockJudgeEntry | MockJudgeEntry[]>) {
  return createMockJudge(levels).model;
}

test("every gate passes → all four passes run → weighted score", async () => {
  const result = await runEssayGraderExample({
    judge: scripted({ relevance: 4, grammar: 3, structure: 3, depth: 3 }),
  });

  expect(result.finalState).toBe("scoring");
  expect(result.stage).toBe("all four stages ran");
  expect(result.finalScore).toBeCloseTo(1 * 0.3 + 0.75 * 0.2 + 0.75 * 0.2 + 0.75 * 0.3);
  expect(result.scores).toEqual({ relevance: 1, grammar: 0.75, structure: 0.75, depth: 0.75 });
  expect(result.report).toMatch(/^Final score 0\.825 \(all four stages ran\)\./);
  // The comment is the matched rubric level, not model prose.
  expect(result.report).toContain(`- relevance 1.00 (weight 0.3): ${RUBRICS.relevance.levels[4]}`);
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
    judge: scripted({ relevance: 1 }),
  });

  expect(result.finalState).toBe("scoring");
  expect(result.stage).toBe("stopped after relevance");
  expect(result.finalScore).toBeCloseTo(0.25 * WEIGHTS.relevance);
  expect(result.scores).toEqual({ relevance: 0.25, grammar: null, structure: null, depth: null });
  expect(result.report).toContain("- grammar: not graded");
  expect(result.progress).toEqual(["checkingRelevance", "scoring"]);
});

test("a score exactly at the threshold does not pass the gate", async () => {
  // Level 2 of 0-4 maps to 0.5, which is RELEVANCE_THRESHOLD itself.
  expect(2 / 4).toBe(RELEVANCE_THRESHOLD);
  const result = await runEssayGraderExample({ judge: scripted({ relevance: 2 }) });
  expect(result.stage).toBe("stopped after relevance");
});

test("low grammar → early exit after the second pass", async () => {
  const result = await runEssayGraderExample({
    judge: scripted({ relevance: 4, grammar: 1 }),
  });

  expect(result.stage).toBe("stopped after grammar");
  expect(result.scores.structure).toBeNull();
  expect(result.progress).toEqual(["checkingRelevance", "checkingGrammar", "scoring"]);
});

test("weak structure → early exit after the third pass", async () => {
  const result = await runEssayGraderExample({
    judge: scripted({ relevance: 4, grammar: 4, structure: 2 }),
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
  // `grammar` has no scripted answer, so the judge call fails.
  const result = await runEssayGraderExample({ judge: scripted({ relevance: 4 }) });

  expect(result.finalState).toBe("failed");
  expect(result.stage).toBe("stopped after relevance");
  expect(result.scores.relevance).toBe(1);
  expect(result.report).toMatch(/^Grading failed; partial score/);
});

test("an out-of-range score fails validation → failed", async () => {
  // Level 7 does not exist on a five-level rubric; the call errors.
  const result = await runEssayGraderExample({ judge: scripted({ relevance: 7 }) });
  expect(result.finalState).toBe("failed");
  expect(result.stage).toBe("no stage completed");
});

test("each pass asks Jev one five-level score over the essay, and stops asking at a failed gate", async () => {
  const jev = createMockJudge({ relevance: 4, grammar: 4, structure: 2 });
  const result = await runEssayGraderExample({ essay: "An essay.", judge: jev.model });

  // One call per pass that ran; depth is never asked once structure fails.
  expect(jev.calls.map((call) => Object.keys(call.questions))).toEqual([
    ["relevance"],
    ["grammar"],
    ["structure"],
  ]);
  for (const call of jev.calls) {
    expect(call.state).toEqual({ essay: "An essay." });
    const question = Object.values(call.questions)[0]!;
    expect(question.type).toBe("score");
    expect(question.type === "score" && question.criteria).toHaveLength(5);
  }
  // Level 2 maps to 0.5, under STRUCTURE_THRESHOLD, so the structure gate stops.
  expect(result.scores.structure).toBe(0.5);
  expect(result.scores.structure!).toBeLessThanOrEqual(STRUCTURE_THRESHOLD);
  expect(result.stage).toBe("stopped after structure");
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
    [good!, { relevance: 4, grammar: 4, structure: 3, depth: 3 }],
    [offTopic!, { relevance: 0, grammar: 4, structure: 0, depth: 0 }],
    [sloppy!, { relevance: 3, grammar: 1, structure: 2, depth: 2 }],
  ]);
  // Answer each criterion from the essay the call's state carries.
  const levelFor = (key: "relevance" | "grammar" | "structure" | "depth") => (state: unknown) =>
    byEssay.get((state as { essay: string }).essay)![key];
  const judge = scripted({
    relevance: levelFor("relevance"),
    grammar: levelFor("grammar"),
    structure: levelFor("structure"),
    depth: levelFor("depth"),
  });

  const stages = [];
  for (const essay of starters) {
    stages.push((await runEssayGraderExample({ essay, judge })).stage);
  }
  expect(stages).toEqual([
    "all four stages ran",
    "stopped after relevance",
    "stopped after grammar",
  ]);
});
