import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { DEFAULT_QUESTION, runRAGExample } from "./index.js";

/** The demo's one-click chips come from metadata.json — keep them corpus-aligned. */
const starters = JSON.parse(readFileSync(new URL("./metadata.json", import.meta.url), "utf8"))
  .starters as Array<{ label: string; input: { question: string } }>;

/** Mocks only the model calls: rewrites get `rewrite`, everything else `answer`. */
function scriptedGenerateText(rewrite: string, answer = "answer") {
  return async (request: { system?: string }) => ({
    output: request.system?.includes("Rewrite it") ? rewrite : answer,
  });
}

test("retrieves relevant docs by keyword and answers grounded on them", async () => {
  // Mock model: echoes how many docs it was grounded on. Real model on direct run.
  const generateText = async ({ prompt }: { prompt?: string }) => {
    const count = (prompt ?? "").match(/^\[\d+\] /gm)?.length ?? 0;
    return { output: `grounded on ${count} docs` };
  };

  const result = await runRAGExample({
    question: "What is context in a state machine?",
    generateText,
  });

  // Retrieval surfaced the context doc via keyword overlap.
  expect(result.documents.some((doc) => doc.includes("extended, quantitative state"))).toBe(true);
  expect(result.documents.length).toBeGreaterThan(0);
  expect(result.documents.length).toBeLessThanOrEqual(3);
  expect(result.answer).toBe(`grounded on ${result.documents.length} docs`);
  // A hit answers straight away: no rewrite, no retry.
  expect(result.rewrittenQuestion).toBeNull();
  expect(result.retrievalNotice).toContain("for the question as asked");
});

test("a miss rewrites the query, retries once, and answers on the retry's evidence", async () => {
  const states: string[] = [];
  const result = await runRAGExample({
    question: DEFAULT_QUESTION,
    generateText: scriptedGenerateText("state transitions events", "transitions move it"),
    onTransition: (snapshot) => states.push(String(snapshot.value)),
  });

  expect(result.rewrittenQuestion).toBe("state transitions events");
  expect(states).toContain("rewritingQuery");
  // Retrieval ran twice: the miss, then the retry that found evidence.
  expect(states.filter((state) => state === "retrieving")).toHaveLength(2);
  expect(result.documents.length).toBeGreaterThan(0);
  expect(result.answer).toBe("transitions move it");
  expect(result.retrievalNotice).toContain("matched no passages");
  expect(result.retrievalNotice).toContain('Rewrote it to "state transitions events"');
  expect(result.retrievalNotice).toContain("The retry found");
});

test("the retry is bounded: a second miss answers without evidence", async () => {
  const states: string[] = [];
  const result = await runRAGExample({
    question: "How should I shard a Postgres database?",
    // The rewrite misses too — the machine must not loop.
    generateText: scriptedGenerateText("postgres sharding", "I could not find that."),
    onTransition: (snapshot) => states.push(String(snapshot.value)),
  });

  expect(states.filter((state) => state === "rewritingQuery")).toHaveLength(1);
  expect(states.filter((state) => state === "retrieving")).toHaveLength(2);
  expect(result.documents).toEqual([]);
  expect(result.retrievalNotice).toContain("The retry found nothing either");
});

test("accumulates conversational memory across a turn", async () => {
  const generateText = async () => ({ output: "a guard is a condition" });

  const result = await runRAGExample({
    question: "What is a guard?",
    generateText,
  });

  expect(result.memory).toEqual(["Q: What is a guard?", "A: a guard is a condition"]);
});

test("each starter behaves as its label advertises", async () => {
  // The rewrite echoes the question, so a chip that misses stays a miss: this
  // test measures the corpus, not the model.
  const generateText = async (request: { system?: string; prompt?: string }) => ({
    output: request.system?.includes("Rewrite it") ? "sharding replicas screens" : "answer",
  });

  for (const starter of starters) {
    const result = await runRAGExample({ question: starter.input.question, generateText });
    const label = starter.label.toLowerCase();
    const expectedHit = label.includes("hits the corpus");
    expect(
      { label: starter.label, hit: result.documents.length > 0 },
      `starter "${starter.label}"`,
    ).toEqual({ label: starter.label, hit: expectedHit });
    // Only the missing chips take the recovery branch.
    expect(result.rewrittenQuestion === null, `starter "${starter.label}" rewrite`).toBe(
      expectedHit,
    );
  }

  // The DEFAULT chip is the one the demo runs first: it misses on purpose, so
  // the rewrite-and-retry branch shows up on every default run.
  expect(starters[0]!.input.question).toBe(DEFAULT_QUESTION);
  // Exactly one deliberate dead-end chip, and it says so on the label.
  expect(starters.filter((s) => s.label.toLowerCase().includes("off-corpus"))).toHaveLength(1);
});
