import { expect, test } from "vitest";
import { createMockJudge } from "../mock-judge.js";
import {
  SUFFICIENCY_THRESHOLD,
  normalizeUrl,
  runDeepResearchExample,
  searchedUrls,
} from "./index.js";

/** The reflection is a Jev judgment: one `sufficient` boolean question per round, in order. */
const reflector = (...sufficient: Array<boolean | number>) => createMockJudge({ sufficient });

/**
 * Response messages shaped like OpenAI's provider-executed web search: one
 * `web_search` tool result listing the pages the search returned.
 */
const searchMessages = (urls: string[]) => [
  {
    role: "assistant",
    content: [
      {
        type: "tool-call",
        toolCallId: "ws_1",
        toolName: "web_search",
        input: {},
        providerExecuted: true,
      },
      {
        type: "tool-result",
        toolCallId: "ws_1",
        toolName: "web_search",
        output: { type: "json", value: { sources: urls.map((url) => ({ type: "url", url })) } },
      },
    ],
  },
];

/** A researcher result whose cited pages are all ones the search returned. */
const withSearch = <T extends { sources: Array<{ url: string }> }>(result: T) => ({
  result,
  messages: searchMessages(result.sources.map((source) => source.url)),
});

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
    judge: reflector(true).model,
    generateText: async (request) => {
      calls.push(request.name);
      if (request.name === "planResearch") {
        return { result: { queries: ["snapshots", "event logs", "retries"] } };
      }
      if (request.name === "research") {
        researched += 1;
        return withSearch(found(request.prompt ?? "", researched));
      }
      return { result: "Durable workflows combine snapshots [1], events [2], and retries [3]." };
    },
  });

  expect(calls.filter((name) => name === "research")).toHaveLength(3);
  expect(output.rounds).toBe(1);
  expect(output.report).toContain("snapshots");
  expect(output.stoppedBy).toMatch(/^Judged sufficient/);
  // Findings read by the query each branch ran, not by branch id.
  expect(Object.keys(output.findings)).toEqual(["snapshots", "event logs", "retries"]);
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
    judge: reflector(true).model,
    generateText: async (request) => {
      if (request.name === "planResearch") return { result: { queries: ["one", "two"] } };
      if (request.name === "research") {
        return withSearch({
          finding: "shared evidence",
          // Both branches cite the SAME page: the ledger dedupes it to [1].
          sources: [
            { title: "Shared page", url: "https://example.com/docs/durability", quote: "q" },
          ],
        });
      }
      writerPrompt = request.prompt ?? "";
      return { result: "Report [1]" };
    },
  });

  expect(writerPrompt).toContain("shared evidence [1]");
  expect(writerPrompt).toContain("[1] Shared page — https://example.com/docs/durability");
  expect(writerPrompt.match(/\[1\] Shared page/g)).toHaveLength(1);
});

test("generic search URLs never reach the ledger", async () => {
  const output = await runDeepResearchExample({
    question: "durability",
    judge: reflector(true).model,
    generateText: async (request) => {
      if (request.name === "planResearch") return { result: { queries: ["one", "two"] } };
      if (request.name === "research") {
        return withSearch({
          finding: "evidence",
          sources: [
            { title: "Search", url: "https://www.google.com/search?q=durability", quote: "q" },
            { title: "Homepage", url: "https://example.com/", quote: "q" },
            { title: "The page", url: "https://example.com/guides/durability", quote: "q" },
          ],
        });
      }
      return { result: "Report [1]" };
    },
  });

  expect(output.sourceLedger).toBe("[1] The page — https://example.com/guides/durability");
});

test("runs one targeted follow-up round when reflection finds a gap", async () => {
  const jev = reflector(false, true);
  const output = await runDeepResearchExample({
    question: "durability",
    judge: jev.model,
    generateText: async (request) => {
      if (request.name === "planResearch") {
        return { result: { queries: ["one", "two", "three"] } };
      }
      if (request.name === "research") {
        return withSearch({
          finding: "evidence",
          sources: [{ title: "Page", url: "https://example.com/a/b", quote: "q" }],
        });
      }
      return { result: "Final report [1]" };
    },
  });

  expect(output.rounds).toBe(2);
  expect(jev.calls).toHaveLength(2);
  // The ledger survives the follow-up round instead of restarting with it.
  expect(output.sourceLedger).toBe("[1] Page — https://example.com/a/b");
});

test("a researcher failure counts as a settlement, so collecting cannot hang", async () => {
  let researched = 0;
  const output = await runDeepResearchExample({
    question: "durability",
    judge: reflector(true).model,
    generateText: async (request) => {
      if (request.name === "planResearch") return { result: { queries: ["one", "two"] } };
      if (request.name === "research") {
        researched += 1;
        // The first researcher dies; the second returns a finding.
        if (researched === 1) throw new Error("search backend down");
        return withSearch(found("two", 1));
      }
      return { result: "Report [1]" };
    },
  });

  // The run finished on one finding instead of parking in `collecting`, and the
  // dead branch is named in the output rather than silently dropped.
  expect(output.failedBranches).toHaveLength(1);
  expect(output.failedBranches[0]).toMatch(/^research-1-\d$/);
  expect(Object.keys(output.findings)).toHaveLength(1);
  expect(output.report).toBe("Report [1]");
  expect(output.failure).toBeNull();
});

test("a failed request ends the run in `failed`, naming the reason", async () => {
  const states: string[] = [];
  const output = await runDeepResearchExample({
    question: "durability",
    onProgress: (state) => states.push(state),
    generateText: async (request) => {
      if (request.name === "planResearch") throw new Error("planner offline");
      return { result: "" };
    },
  });

  expect(states.at(-1)).toBe("failed");
  expect(output.failure).toMatch(/planResearch failed/);
  expect(output.report).toBe("");
});

test("reflection asks Jev one boolean question over the findings, and the threshold decides another round", async () => {
  const planned: Array<string | undefined> = [];
  const run = (sufficient: number) => {
    const jev = reflector(sufficient, 1);
    return runDeepResearchExample({
      question: "durability",
      judge: jev.model,
      generateText: async (request) => {
        if (request.name === "planResearch") {
          planned.push(request.prompt);
          return { result: { queries: ["one", "two"] } };
        }
        if (request.name === "research") {
          return withSearch({
            finding: "snapshots persist state",
            sources: [{ title: "Page", url: "https://example.com/a/b", quote: "q" }],
          });
        }
        return { result: "Report [1]" };
      },
    }).then((output) => ({ output, jev }));
  };

  // Exactly at the threshold: sufficient, one round.
  const enough = await run(SUFFICIENCY_THRESHOLD);
  expect(enough.output.rounds).toBe(1);
  expect(enough.jev.calls).toHaveLength(1);
  const call = enough.jev.calls[0]!;
  expect(call.state).toEqual({
    question: "durability",
    findings: ["snapshots persist state [1]", "snapshots persist state [1]"],
  });
  expect(Object.keys(call.questions)).toEqual(["sufficient"]);
  expect(call.questions.sufficient!.type).toBe("boolean");

  // Just under it: a second round, and the planner is handed the findings.
  planned.length = 0;
  const short = await run(SUFFICIENCY_THRESHOLD - 0.01);
  expect(short.output.rounds).toBe(2);
  expect(short.jev.calls).toHaveLength(2);
  expect(planned[0]).toContain("Coverage feedback: none");
  expect(planned[1]).toContain("do not answer the question comprehensively");
  expect(planned[1]).toContain("- snapshots persist state [1]");
});

test("findings that never suffice stop at the round budget, and the output says which rule ended it", async () => {
  const jev = reflector(false, false);
  const output = await runDeepResearchExample({
    question: "durability",
    judge: jev.model,
    generateText: async (request) => {
      if (request.name === "planResearch") return { result: { queries: ["one", "two"] } };
      if (request.name === "research") {
        return withSearch({
          finding: "thin",
          sources: [{ title: "Page", url: "https://example.com/a/b", quote: "q" }],
        });
      }
      return { result: "Report [1]" };
    },
  });

  // Two rounds, two judgments, then the writer runs anyway: no third round.
  expect(output.rounds).toBe(2);
  expect(jev.calls).toHaveLength(2);
  expect(output.stoppedBy).toMatch(/^Round budget of 2 spent \(0\.\d\d < /);
});

test("searchedUrls reads the search results and URL citations off the response messages", () => {
  const messages = [
    ...searchMessages([
      "https://www.energy.gov/science/doe-explainsdirect-air-capture",
      "https://www.iea.org/reports/direct-air-capture-2022/",
    ]),
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "{}",
          providerOptions: {
            openai: {
              annotations: [
                {
                  type: "url_citation",
                  url: "https://climeworks.com/sustainability?utm_source=openai",
                  title: "Climeworks",
                },
              ],
            },
          },
        },
      ],
    },
    { role: "user", content: "not an assistant part list" },
  ];

  expect([...searchedUrls(messages)]).toEqual([
    "https://www.energy.gov/science/doe-explainsdirect-air-capture",
    "https://www.iea.org/reports/direct-air-capture-2022",
    "https://climeworks.com/sustainability",
  ]);
  expect(normalizeUrl("https://example.com/a/?utm_source=openai&id=2#top")).toBe(
    "https://example.com/a?id=2",
  );
  expect(normalizeUrl("not a url")).toBeNull();
});

test("a cited page the search never returned stays out of the ledger", async () => {
  const output = await runDeepResearchExample({
    question: "durability",
    judge: reflector(true).model,
    generateText: async (request) => {
      if (request.name === "planResearch") return { result: { queries: ["one", "two"] } };
      if (request.name === "research") {
        return {
          result: {
            finding: "evidence",
            sources: [
              // Returned by the search (with a tracking param the ledger drops).
              { title: "Found", url: "https://example.com/found?utm_source=openai", quote: "q" },
              // Written by the model, never returned by the search.
              { title: "Recalled", url: "https://example.com/recalled", quote: "q" },
            ],
          },
          messages: searchMessages(["https://example.com/found"]),
        };
      }
      return { result: "Report [1]" };
    },
  });

  expect(output.sourceLedger).toBe("[1] Found — https://example.com/found");
  expect(Object.values(output.findings)).toEqual(["evidence [1]", "evidence [1]"]);
});

test("a researcher whose search returned nothing contributes a finding with no citations", async () => {
  const output = await runDeepResearchExample({
    question: "durability",
    judge: reflector(true).model,
    generateText: async (request) => {
      if (request.name === "planResearch") return { result: { queries: ["one", "two"] } };
      if (request.name === "research") {
        return { result: found("one", 1) };
      }
      return { result: "Report" };
    },
  });

  expect(output.sourceLedger).toBe("");
  expect(Object.values(output.findings)).toEqual(["finding for one", "finding for one"]);
});
