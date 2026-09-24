import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { type AgentTextRequest } from "@statelyai/agent";
import { lintAgentMachine } from "@statelyai/agent/testing";
import { createMockModelExecutors } from "../mock-model.js";
import {
  MAX_BATCHES,
  MAX_DOCUMENTS,
  MAX_CATEGORIES,
  SAMPLE_DOCUMENTS,
  SUMMARY_UNAVAILABLE,
  runTntLlmExample,
  tntLlmMachine,
} from "./index.js";

/** One summarizer child per document; the summary echoes it, so batches are traceable. */
const summarizeOne = (request: AgentTextRequest) => ({
  summary: `S: ${(request.input as { document: string }).document}`,
});

const categories = (count: number, prefix = "Intent") => ({
  taxonomy: Array.from({ length: count }, (_, i) => ({
    name: `${prefix} ${i + 1}`,
    description: `what ${prefix} ${i + 1} covers`,
  })),
});

/** State path with `summarizing` collapsed: each landed summarizer child is its own transition. */
const path = (progress: string[]) =>
  progress.filter((state, i) => state !== "summarizing" || progress[i - 1] !== "summarizing");

/** Mock only the model, keyed by REQUEST NAME; also returns the observed calls. */
function scripted(text: Record<string, unknown[]>) {
  const executors = createMockModelExecutors({
    text: {
      summarize: [summarizeOne],
      generateTaxonomy: [categories(3, "Draft")],
      updateTaxonomy: [categories(4, "Updated")],
      reviewTaxonomy: [categories(4, "Final")],
      ...text,
    },
  });
  const calls = (name: string) => executors.calls.filter((call) => call.name === name);
  return { generateText: executors.generateText, calls };
}

test("three batches of 4 → generate on batch 0, update on batches 1 and 2, review", async () => {
  const { generateText, calls } = scripted({});
  const result = await runTntLlmExample({ batchSize: 4, generateText });

  expect(result.finalState).toBe("done");
  expect(result.batches).toEqual([
    [0, 1, 2, 3],
    [4, 5, 6, 7],
    [8, 9, 10, 11],
  ]);
  expect(path(result.progress)).toEqual([
    "summarizing",
    "generatingTaxonomy",
    "updatingTaxonomy",
    "updatingTaxonomy",
    "reviewingTaxonomy",
    "done",
  ]);
  // Each update sees its own batch's summaries; review sees the last batch.
  const updates = calls("updateTaxonomy").map(
    (call) => (call.input as { summaries: string[] }).summaries,
  );
  expect(updates[0]![0]).toBe(`S: ${SAMPLE_DOCUMENTS[4]}`);
  expect(updates[1]![0]).toBe(`S: ${SAMPLE_DOCUMENTS[8]}`);
  expect((calls("reviewTaxonomy")[0]!.input as { summaries: string[] }).summaries).toEqual(
    updates[1],
  );
  expect(result.taxonomy.map((category) => category.name)).toEqual([
    "Final 1",
    "Final 2",
    "Final 3",
    "Final 4",
  ]);
  expect(result.report).toMatch(/^Taxonomy of 4 categories from 12 documents in 3 minibatch/);
  expect(result.report).toContain("- Final 1 — what Final 1 covers");
});

test("one batch → generate, then straight to review (no update)", async () => {
  const { generateText } = scripted({});
  const result = await runTntLlmExample({ batchSize: 12, generateText });

  expect(result.batches).toHaveLength(1);
  expect(path(result.progress)).toEqual([
    "summarizing",
    "generatingTaxonomy",
    "reviewingTaxonomy",
    "done",
  ]);
});

test("batch size 1 → one update per later document", async () => {
  const { generateText, calls } = scripted({});
  const result = await runTntLlmExample({ batchSize: 1, generateText });

  expect(result.finalState).toBe("done");
  expect(result.batches).toHaveLength(SAMPLE_DOCUMENTS.length);
  expect(calls("updateTaxonomy")).toHaveLength(SAMPLE_DOCUMENTS.length - 1);
  expect(calls("reviewTaxonomy")).toHaveLength(1);
});

test("one summarize child per document; results reduce in document order", async () => {
  // Later documents finish FIRST: the reduce still writes each by index.
  const { generateText, calls } = scripted({
    summarize: [
      async (request: AgentTextRequest) => {
        const { document } = request.input as { document: string };
        const index = SAMPLE_DOCUMENTS.indexOf(document);
        await new Promise((resolve) => setTimeout(resolve, (SAMPLE_DOCUMENTS.length - index) * 2));
        return { summary: `S: ${document}` };
      },
    ],
  });
  const result = await runTntLlmExample({ batchSize: 12, generateText });

  expect(result.finalState).toBe("done");
  expect(calls("summarize")).toHaveLength(SAMPLE_DOCUMENTS.length);
  expect((calls("generateTaxonomy")[0]!.input as { summaries: string[] }).summaries).toEqual(
    SAMPLE_DOCUMENTS.map((doc) => `S: ${doc}`),
  );
});

test("a failed summarizer child records a placeholder instead of stalling", async () => {
  const { generateText, calls } = scripted({
    summarize: [
      (request: AgentTextRequest) => {
        const { document } = request.input as { document: string };
        if (document === SAMPLE_DOCUMENTS[1]) throw new Error("model unavailable");
        return { summary: `S: ${document}` };
      },
    ],
  });
  const result = await runTntLlmExample({ batchSize: 12, generateText });

  expect(result.finalState).toBe("done");
  const summaries = (calls("generateTaxonomy")[0]!.input as { summaries: string[] }).summaries;
  expect(summaries[1]).toBe(SUMMARY_UNAVAILABLE);
  expect(summaries[0]).toBe(`S: ${SAMPLE_DOCUMENTS[0]}`);
  expect(summaries).toHaveLength(SAMPLE_DOCUMENTS.length);
});

test("too many categories → truncated to MAX_CATEGORIES and counted", async () => {
  const { generateText } = scripted({
    generateTaxonomy: [categories(MAX_CATEGORIES + 3)],
    reviewTaxonomy: [categories(MAX_CATEGORIES + 1, "Final")],
  });
  const result = await runTntLlmExample({ batchSize: 12, generateText });

  expect(result.finalState).toBe("done");
  expect(result.taxonomy).toHaveLength(MAX_CATEGORIES);
  expect(result.droppedCategories).toBe(4);
  expect(result.report).toContain("4 over the cap dropped");
});

test("more minibatches than MAX_BATCHES → failed before any taxonomy call", async () => {
  const documents = Array.from({ length: MAX_BATCHES + 1 }, (_, i) => `User: question ${i}`);
  const { generateText, calls } = scripted({});
  const result = await runTntLlmExample({ documents, batchSize: 1, generateText });

  expect(result.finalState).toBe("failed");
  expect(calls("generateTaxonomy")).toHaveLength(0);
  expect(result.report).toContain("exceed MAX_BATCHES");
});

test("a failing update keeps the partial taxonomy in failed", async () => {
  const { generateText } = scripted({
    updateTaxonomy: [
      () => {
        throw new Error("model unavailable");
      },
    ],
  });
  const result = await runTntLlmExample({ generateText });

  expect(result.finalState).toBe("failed");
  expect(result.report).toContain("a taxonomy request failed");
  expect(result.taxonomy.map((category) => category.name)).toEqual([
    "Draft 1",
    "Draft 2",
    "Draft 3",
  ]);
});

test("machine lints clean", () => {
  expect(() => lintAgentMachine(tntLlmMachine, { throw: true })).not.toThrow();
});

type Starter = { label: string; input: { batchSize: number } };
const starters = JSON.parse(readFileSync(new URL("./metadata.json", import.meta.url), "utf8"))
  .starters as Starter[];

test("starters behave as their labels advertise", async () => {
  const updatesByLabel = new Map<string, number>();
  for (const starter of starters) {
    const { generateText, calls } = scripted({});
    const result = await runTntLlmExample({ batchSize: starter.input.batchSize, generateText });
    expect(result.finalState, starter.label).toBe("done");
    expect(calls("generateTaxonomy"), starter.label).toHaveLength(1);
    expect(calls("reviewTaxonomy"), starter.label).toHaveLength(1);
    updatesByLabel.set(starter.label, calls("updateTaxonomy").length);
  }
  expect(Object.fromEntries(updatesByLabel)).toEqual({
    "Three batches of 4 — generate, update twice, review": 2,
    "One batch of 12 — generate, then review": 0,
    "Batch size 1 — generate, eleven updates, review": 11,
  });
});

test("more documents than MAX_DOCUMENTS are rejected at the input boundary", async () => {
  const documents = Array.from({ length: MAX_DOCUMENTS + 1 }, (_, i) => `User: question ${i}`);
  await expect(
    runTntLlmExample({
      documents,
      batchSize: MAX_DOCUMENTS,
      generateText: createMockModelExecutors({ text: { "*": "unused" } }).generateText,
    }),
  ).rejects.toThrow();
});
