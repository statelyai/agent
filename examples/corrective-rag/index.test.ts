import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { createMockJudge } from "../mock-judge.js";
import { createMockModelExecutors } from "../mock-model.js";
import { RELEVANCE_THRESHOLD, correctiveRagMachine, runCorrectiveRagExample } from "./index.js";

/**
 * Mock the text model, keyed by REQUEST NAME (`rewriteQuery` /
 * `generateAnswer`), so an answer cannot land on the wrong call when the
 * machine takes a different branch. The grader is an evaluation-model
 * judgment, scripted separately by question id through a mock judge that
 * implements the AI SDK's evaluation-model spec. The retrieve/webSearch
 * actors run REAL keyword logic.
 */
function scriptedGenerateText(text: { rewriteQuery?: unknown[]; generateAnswer?: unknown[] }) {
  return createMockModelExecutors({ text }).generateText;
}

/** Every document graded relevant (or not): one boolean per `doc<i>` question. */
const grader = (relevant: boolean) => createMockJudge({ "*": relevant }).model;

test("relevant docs → straight to generate (no correction)", async () => {
  const result = await runCorrectiveRagExample({
    // On-topic for the sample corpus.
    question: "How does long-term memory work for LLM agents?",
    generateText: scriptedGenerateText({
      generateAnswer: ["Long-term memory persists facts across sessions in an external store."],
    }),
    judge: grader(true),
  });

  expect(result.answer).toContain("Long-term memory");
  expect(result.retrievalNotice).toContain("Primary index returned");
  expect(result.retrievalNotice).toContain("no correction needed");
  expect(result.usedFallbackIndex).toBe(false);
  expect(result.rewrittenQuestion).toBeNull();
  // Grading happened; the correction branch did NOT.
  expect(result.progress).toContain("grading");
  expect(result.progress).not.toContain("transformingQuery");
  expect(result.progress).not.toContain("webSearching");
  expect(result.progress.at(-1)).toBe("done");
});

test("docs retrieved but all irrelevant → rewrite + web-search fallback", async () => {
  const result = await runCorrectiveRagExample({
    // Overlaps the corpus ("agents") so retrieval is non-empty, but the grader
    // (mocked) judges every doc irrelevant — the CRAG correction trigger.
    question: "What is prompt injection and how do agents defend against it?",
    judge: grader(false),
    generateText: scriptedGenerateText({
      rewriteQuery: ["prompt injection attack defense for agents"],
      generateAnswer: [
        "Prompt injection overrides an agent's instructions; defend with sanitization and privilege separation.",
      ],
    }),
  });

  expect(result.usedFallbackIndex).toBe(true);
  expect(result.rewrittenQuestion).toBe("prompt injection attack defense for agents");
  expect(result.retrievalNotice).toContain("The grader kept 0 of");
  expect(result.retrievalNotice).toContain("Corrected: rewrote the question");
  // Full correction branch is visible in the state progression.
  expect(result.progress).toContain("grading");
  expect(result.progress).toContain("transformingQuery");
  expect(result.progress).toContain("webSearching");
  expect(result.progress.indexOf("transformingQuery")).toBeLessThan(
    result.progress.indexOf("webSearching"),
  );
  expect(result.progress.at(-1)).toBe("done");
  // Web results were appended to the working doc set.
  expect(result.documents.some((d) => d.startsWith("[sample web result]"))).toBe(true);
});

test("no docs retrieved → skip grading, correct via web search", async () => {
  const result = await runCorrectiveRagExample({
    // Off-topic for the corpus → retrieval returns nothing → grading is skipped.
    question: "What is the weather forecast today?",
    generateText: scriptedGenerateText({
      rewriteQuery: ["weather forecast today temperature"],
      generateAnswer: ["Expect mild temperatures with scattered showers."],
    }),
  });

  expect(result.usedFallbackIndex).toBe(true);
  expect(result.retrievalNotice).toContain("Primary index returned no matching documents.");
  expect(result.retrievalNotice).toContain("fallback sample web index");
  expect(result.progress).not.toContain("grading");
  expect(result.progress).toContain("transformingQuery");
  expect(result.progress).toContain("webSearching");
  expect(result.progress.at(-1)).toBe("done");
});

test("starters behave as their labels advertise", async () => {
  const starters = JSON.parse(readFileSync(new URL("./metadata.json", import.meta.url), "utf8"))
    .starters as Array<{ label: string; input: { question: string } }>;

  const results = new Map<string, Awaited<ReturnType<typeof runCorrectiveRagExample>>>();
  for (const starter of starters) {
    const keepDocs = starter.label.startsWith("Corpus hit");
    const result = await runCorrectiveRagExample({
      question: starter.input.question,
      // Only the model calls are mocked; retrieve/webSearch run real keyword
      // logic over the sample corpora, so this test measures the corpora.
      judge: grader(keepDocs),
      generateText: scriptedGenerateText({
        rewriteQuery: [starter.input.question],
        generateAnswer: ["answer"],
      }),
    });
    results.set(starter.label, result);
  }

  // The DEFAULT chip is the one the demo runs first: its question matches
  // nothing in the primary corpus, so the correction branch runs on every run,
  // whatever the grader says.
  const defaultStarter = results.get(starters[0]!.label)!;
  expect(defaultStarter.usedFallbackIndex).toBe(true);
  expect(defaultStarter.progress).not.toContain("grading");
  expect(defaultStarter.progress).toContain("transformingQuery");
  expect(defaultStarter.retrievalNotice).toContain("no matching documents");
  expect(defaultStarter.retrievalNotice).toContain("Corrected");

  const hit = results.get("Corpus hit — answers without correcting")!;
  expect(hit.usedFallbackIndex).toBe(false);
  expect(hit.documents.some((doc) => doc.includes("long-term memory"))).toBe(true);

  const nearMiss = results.get("Near-miss doc — graded away, then corrected")!;
  expect(nearMiss.usedFallbackIndex).toBe(true);
  expect(nearMiss.documents.some((doc) => doc.includes("vector database"))).toBe(true);

  const corrected = results.get("Corpus miss — corrected via the sample index")!;
  expect(corrected.usedFallbackIndex).toBe(true);
  expect(corrected.documents.some((doc) => doc.includes("Prompt injection"))).toBe(true);

  // The one deliberate miss: even the fallback index has nothing, and the
  // labeled chip says so up front.
  const offCorpus = starters.filter((starter) => starter.label.includes("Off-corpus"));
  expect(offCorpus).toHaveLength(1);
  const miss = results.get(offCorpus[0]!.label)!;
  expect(miss.documents).toEqual(["[sample web result] No external results found for this query."]);
});

test("the grader asks one boolean per document and keeps only those above the threshold", async () => {
  // Three docs overlap "agents" and "memory"; grade only the first relevant.
  const judge = createMockJudge({ doc0: 0.9, "*": RELEVANCE_THRESHOLD - 0.1 });
  const result = await runCorrectiveRagExample({
    question: "How does long-term memory work for LLM agents?",
    generateText: scriptedGenerateText({ generateAnswer: ["answer"] }),
    judge: judge.model,
  });

  expect(judge.calls).toHaveLength(1);
  const call = judge.calls[0]!;
  expect(Object.keys(call.questions)).toEqual(
    (call.state as { documents: string[] }).documents.map((_, i) => `doc${i}`),
  );
  expect(Object.values(call.questions).every((q) => q.type === "boolean")).toBe(true);
  expect(result.documents).toHaveLength(1);
  expect(result.retrievalNotice).toContain("kept 1 of");
  expect(result.usedFallbackIndex).toBe(false);
});

test("machine exports a runnable definition", () => {
  expect(correctiveRagMachine.id).toBe("corrective-rag");
});
