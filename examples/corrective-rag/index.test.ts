import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { createScriptedExecutors } from "@statelyai/agent";
import { correctiveRagMachine, runCorrectiveRagExample } from "./index.js";

/**
 * Mock the model, keyed by REQUEST NAME (`gradeDocuments` / `rewriteQuery` /
 * `generateAnswer`), so an answer cannot land on the wrong call when the
 * machine takes a different branch. The retrieve/webSearch actors run REAL
 * keyword logic — only the model calls are mocked.
 */
function scriptedGenerateText(text: {
  gradeDocuments?: unknown[];
  rewriteQuery?: unknown[];
  generateAnswer?: unknown[];
}) {
  return createScriptedExecutors({ text, repeat: true }).generateText;
}

const allRelevant = { grades: [{ relevant: true }, { relevant: true }, { relevant: true }] };
const noneRelevant = { grades: [{ relevant: false }, { relevant: false }, { relevant: false }] };

test("relevant docs → straight to generate (no correction)", async () => {
  const result = await runCorrectiveRagExample({
    // On-topic for the sample corpus.
    question: "How does long-term memory work for LLM agents?",
    generateText: scriptedGenerateText({
      gradeDocuments: [allRelevant],
      generateAnswer: ["Long-term memory persists facts across sessions in an external store."],
    }),
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
    generateText: scriptedGenerateText({
      gradeDocuments: [noneRelevant],
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
      generateText: scriptedGenerateText({
        gradeDocuments: [{ grades: Array.from({ length: 3 }, () => ({ relevant: keepDocs })) }],
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

test("machine exports a runnable definition", () => {
  expect(correctiveRagMachine.id).toBe("corrective-rag");
});
