import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { lintAgentMachine } from "@statelyai/agent/testing";
import { createMockModelExecutors } from "../mock-model.js";
import {
  MAX_REGENERATIONS,
  MAX_REWRITES,
  adaptiveRagMachine,
  runAdaptiveRagExample,
} from "./index.js";

/**
 * Mock the model, keyed by REQUEST NAME, so an answer cannot land on the wrong
 * call when the machine takes a different branch. The retrieve/webSearch
 * actors run REAL keyword logic; only the model calls are mocked.
 */
function scripted(text: Record<string, unknown[]>) {
  return createMockModelExecutors({ text }).generateText;
}

const toVectorstore = { datasource: "vectorstore" };
const toWebsearch = { datasource: "websearch" };
const allRelevant = { grades: [{ relevant: true }, { relevant: true }, { relevant: true }] };
const noneRelevant = { grades: [{ relevant: false }, { relevant: false }, { relevant: false }] };

test("vectorstore route: retrieve → grade → generate → both checks pass → done", async () => {
  const result = await runAdaptiveRagExample({
    question: "How do LLM agents use long-term memory?",
    generateText: scripted({
      routeQuestion: [toVectorstore],
      gradeDocuments: [allRelevant],
      generateAnswer: ["Agents persist long-term memory in an external store via tools."],
      gradeGrounding: [{ grounded: true }],
      gradeUsefulness: [{ useful: true }],
    }),
  });

  expect(result.finalState).toBe("done");
  expect(result.route).toBe("vectorstore");
  expect(result.answer).toContain("long-term memory");
  expect(result.rewrites).toBe(0);
  expect(result.regenerations).toBe(0);
  expect(result.trail).toContain("passed the hallucination and usefulness checks");
  expect(result.progress).toEqual([
    "routing",
    "retrieving",
    "grading",
    "generating",
    "checkingGrounding",
    "checkingUsefulness",
    "done",
  ]);
});

test("websearch route: skips retrieval and grading, answers from the sample web index", async () => {
  const result = await runAdaptiveRagExample({
    question: "What is the latest guidance on defending agents against prompt injection?",
    generateText: scripted({
      routeQuestion: [toWebsearch],
      generateAnswer: ["Treat retrieved text as untrusted and separate privileges."],
      gradeGrounding: [{ grounded: true }],
      gradeUsefulness: [{ useful: true }],
    }),
  });

  expect(result.finalState).toBe("done");
  expect(result.route).toBe("websearch");
  expect(result.documents[0]).toMatch(/^\[sample web result\] Latest guidance on prompt injection/);
  expect(result.progress).not.toContain("retrieving");
  expect(result.progress).not.toContain("grading");
  expect(result.progress.slice(0, 3)).toEqual(["routing", "searchingWeb", "generating"]);
});

test("nothing relevant → rewrite → retrieve again → answered", async () => {
  const result = await runAdaptiveRagExample({
    question: "How do agents plan hard goals?",
    generateText: scripted({
      routeQuestion: [toVectorstore],
      gradeDocuments: [noneRelevant, allRelevant],
      rewriteQuestion: ["agent planning task decomposition subgoals"],
      generateAnswer: ["Agents decompose a goal into ordered subgoals."],
      gradeGrounding: [{ grounded: true }],
      gradeUsefulness: [{ useful: true }],
    }),
  });

  expect(result.finalState).toBe("done");
  expect(result.rewrites).toBe(1);
  expect(result.documents.some((doc) => doc.includes("Task decomposition"))).toBe(true);
  expect(result.progress.slice(0, 7)).toEqual([
    "routing",
    "retrieving",
    "grading",
    "rewriting",
    "retrieving",
    "grading",
    "generating",
  ]);
});

test("hallucination check fails once → regenerate → answered", async () => {
  const result = await runAdaptiveRagExample({
    generateText: scripted({
      routeQuestion: [toVectorstore],
      gradeDocuments: [allRelevant],
      generateAnswer: ["Agents store memory on the moon.", "Agents persist memory externally."],
      gradeGrounding: [{ grounded: false }, { grounded: true }],
      gradeUsefulness: [{ useful: true }],
    }),
  });

  expect(result.finalState).toBe("done");
  expect(result.regenerations).toBe(1);
  expect(result.answer).toBe("Agents persist memory externally.");
  expect(result.trail).toContain(`Regenerated 1 of ${MAX_REGENERATIONS}`);
  expect(result.progress.filter((state) => state === "generating")).toHaveLength(2);
});

test("never grounded → regeneration budget exhausted → failed with the unverified draft", async () => {
  const result = await runAdaptiveRagExample({
    generateText: scripted({
      routeQuestion: [toVectorstore],
      gradeDocuments: [allRelevant],
      generateAnswer: ["Agents store memory on the moon."],
      gradeGrounding: [{ grounded: false }],
    }),
  });

  expect(result.finalState).toBe("failed");
  expect(result.regenerations).toBe(MAX_REGENERATIONS);
  expect(result.progress.filter((state) => state === "generating")).toHaveLength(
    MAX_REGENERATIONS + 1,
  );
  expect(result.answer).toBe("Unverified (did not pass grading): Agents store memory on the moon.");
  expect(result.trail).toContain("regeneration budget exhausted");
});

test("grounded but not useful → rewrite → retrieve → answered", async () => {
  const result = await runAdaptiveRagExample({
    generateText: scripted({
      routeQuestion: [toVectorstore],
      gradeDocuments: [allRelevant],
      rewriteQuestion: ["long-term memory tools for LLM agents"],
      generateAnswer: ["Memory is a thing.", "A retrieval tool fetches past facts."],
      gradeGrounding: [{ grounded: true }],
      gradeUsefulness: [{ useful: false }, { useful: true }],
    }),
  });

  expect(result.finalState).toBe("done");
  expect(result.rewrites).toBe(1);
  expect(result.answer).toBe("A retrieval tool fetches past facts.");
  const firstCheck = result.progress.indexOf("checkingUsefulness");
  expect(result.progress.slice(firstCheck, firstCheck + 3)).toEqual([
    "checkingUsefulness",
    "rewriting",
    "retrieving",
  ]);
});

test("corpus miss → rewrite budget exhausted → failed, with no fabricated answer", async () => {
  const result = await runAdaptiveRagExample({
    question: "What is chain-of-thought prompting?",
    generateText: scripted({
      routeQuestion: [toVectorstore],
      rewriteQuestion: ["chain of thought prompting explained"],
    }),
  });

  expect(result.finalState).toBe("failed");
  expect(result.rewrites).toBe(MAX_REWRITES);
  expect(result.progress.filter((state) => state === "retrieving")).toHaveLength(MAX_REWRITES + 1);
  expect(result.progress).not.toContain("grading");
  expect(result.progress).not.toContain("generating");
  expect(result.answer).toBe("Unable to produce a grounded, useful answer for this question.");
  expect(result.trail).toContain("rewrite budget exhausted");
});

test("a failing model call lands in failed, not an unhandled error", async () => {
  const result = await runAdaptiveRagExample({
    generateText: scripted({ routeQuestion: [toVectorstore] }),
  });
  // gradeDocuments has no scripted answer, so the executor throws.
  expect(result.finalState).toBe("failed");
  expect(result.trail).toContain("gradeDocuments failed");
});

type Starter = { label: string; input: { question: string } };
const starters = JSON.parse(readFileSync(new URL("./metadata.json", import.meta.url), "utf8"))
  .starters as Starter[];

const CORPUS_HIT = "Corpus hit — graded, grounded, answered";
const CURRENT_EVENTS = "Current-events question — routed to the sample web index";
const CORPUS_MISS = "Not in the corpus — rewrites run out, ends in failed";

test("starters behave as their labels advertise", async () => {
  expect(starters.map((starter) => starter.label)).toEqual([
    CORPUS_HIT,
    CURRENT_EVENTS,
    CORPUS_MISS,
  ]);
  const results = new Map<string, Awaited<ReturnType<typeof runAdaptiveRagExample>>>();
  for (const starter of starters) {
    results.set(
      starter.label,
      await runAdaptiveRagExample({
        question: starter.input.question,
        // The router sends the current-events question to websearch and the
        // rest to the vectorstore; graders approve; the rewriter echoes the
        // question, so retrieval is measured against the real corpus.
        generateText: scripted({
          routeQuestion: [starter.label === CURRENT_EVENTS ? toWebsearch : toVectorstore],
          gradeDocuments: [allRelevant],
          rewriteQuestion: [starter.input.question],
          generateAnswer: ["answer"],
          gradeGrounding: [{ grounded: true }],
          gradeUsefulness: [{ useful: true }],
        }),
      }),
    );
  }

  const hit = results.get(CORPUS_HIT)!;
  expect(hit.finalState).toBe("done");
  expect(hit.route).toBe("vectorstore");
  expect(hit.documents.some((doc) => doc.includes("long-term memory"))).toBe(true);

  const web = results.get(CURRENT_EVENTS)!;
  expect(web.finalState).toBe("done");
  expect(web.route).toBe("websearch");
  expect(web.documents[0]).toContain("prompt injection");

  const miss = results.get(CORPUS_MISS)!;
  expect(miss.finalState).toBe("failed");
  expect(miss.rewrites).toBe(MAX_REWRITES);
});

test("machine lints clean", () => {
  expect(() => lintAgentMachine(adaptiveRagMachine, { throw: true })).not.toThrow();
});
