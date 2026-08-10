import { expect, test } from "vitest";
import { runDeepResearchExample } from "./index.js";

/** A researcher result: one finding plus the page it came from. */
const found = (query: string, index: number) => ({
  finding: `finding for ${query}`,
  sources: [
    {
      title: `Source ${index}`,
      url: `https://example.com/papers/${index}`,
      quote: `line ${index}`,
    },
  ],
});

test("plans, researches in parallel, reflects, and writes", async () => {
  const calls: string[] = [];
  let researched = 0;
  const output = await runDeepResearchExample({
    question: "durability",
    generateText: async (request) => {
      calls.push(request.model);
      if (request.model === "planner") {
        return { output: { queries: ["snapshots", "event logs", "retries"] } };
      }
      if (request.model === "researcher") {
        researched += 1;
        return { output: found(request.prompt ?? "", researched) };
      }
      if (request.model === "reflector") return { output: { sufficient: true, gaps: "" } };
      return { output: "Durable workflows combine snapshots [1], events [2], and retries [3]." };
    },
  });

  expect(calls.filter((model) => model === "researcher")).toHaveLength(3);
  expect(output.rounds).toBe(1);
  expect(output.report).toContain("snapshots");
  expect(Object.values(output.findings).every(Boolean)).toBe(true);
  // Every finding carries the citation marker of the page it rests on.
  expect(Object.values(output.findings).every((finding) => /\[\d+\]$/.test(finding))).toBe(true);
  // The ledger is one line per source, numbered to match those markers.
  expect(output.sourceLedger.split("\n")).toEqual([
    "[1] Source 1 — https://example.com/papers/1",
    "[2] Source 2 — https://example.com/papers/2",
    "[3] Source 3 — https://example.com/papers/3",
  ]);
});

test("the writer is handed the ledger and the findings' markers", async () => {
  let writerPrompt = "";
  await runDeepResearchExample({
    question: "durability",
    generateText: async (request) => {
      if (request.model === "planner") return { output: { queries: ["one", "two"] } };
      if (request.model === "researcher") {
        return {
          output: {
            finding: "shared evidence",
            // Both branches cite the SAME page: the ledger dedupes it to [1].
            sources: [
              { title: "Shared page", url: "https://example.com/docs/durability", quote: "q" },
            ],
          },
        };
      }
      if (request.model === "reflector") return { output: { sufficient: true, gaps: "" } };
      writerPrompt = request.prompt ?? "";
      return { output: "Report [1]" };
    },
  });

  expect(writerPrompt).toContain("shared evidence [1]");
  expect(writerPrompt).toContain("[1] Shared page — https://example.com/docs/durability");
  expect(writerPrompt.match(/\[1\] Shared page/g)).toHaveLength(1);
});

test("generic search URLs never reach the ledger", async () => {
  const output = await runDeepResearchExample({
    question: "durability",
    generateText: async (request) => {
      if (request.model === "planner") return { output: { queries: ["one", "two"] } };
      if (request.model === "researcher") {
        return {
          output: {
            finding: "evidence",
            sources: [
              { title: "Search", url: "https://www.google.com/search?q=durability", quote: "q" },
              { title: "Homepage", url: "https://example.com/", quote: "q" },
              { title: "The page", url: "https://example.com/guides/durability", quote: "q" },
            ],
          },
        };
      }
      if (request.model === "reflector") return { output: { sufficient: true, gaps: "" } };
      return { output: "Report [1]" };
    },
  });

  expect(output.sourceLedger).toBe("[1] The page — https://example.com/guides/durability");
});

test("runs one targeted follow-up round when reflection finds a gap", async () => {
  let reflections = 0;
  const output = await runDeepResearchExample({
    question: "durability",
    generateText: async (request) => {
      if (request.model === "planner") {
        return { output: { queries: ["one", "two", "three"] } };
      }
      if (request.model === "researcher") {
        return {
          output: {
            finding: "evidence",
            sources: [{ title: "Page", url: "https://example.com/a/b", quote: "q" }],
          },
        };
      }
      if (request.model === "reflector") {
        reflections++;
        return { output: { sufficient: reflections === 2, gaps: "failure recovery" } };
      }
      return { output: "Final report [1]" };
    },
  });

  expect(output.rounds).toBe(2);
  expect(reflections).toBe(2);
  // The ledger survives the follow-up round instead of restarting with it.
  expect(output.sourceLedger).toBe("[1] Page — https://example.com/a/b");
});
