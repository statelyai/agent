import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { lintAgentMachine } from "@statelyai/agent/testing";
import { createMockJudge, type MockJudgeEntry } from "../mock-judge.js";
import { createMockModelExecutors } from "../mock-model.js";
import {
  ANSWER_SYSTEM_PROMPT,
  GROUNDED_THRESHOLD,
  MAX_REGENERATIONS,
  MAX_REWRITES,
  RELEVANCE_THRESHOLD,
  USEFUL_THRESHOLD,
  adaptiveRagMachine,
  runAdaptiveRagExample,
} from "./index.js";

/**
 * Mock the text model, keyed by REQUEST NAME (`rewriteQuestion` /
 * `generateAnswer`), so an answer cannot land on the wrong call when the
 * machine takes a different branch. The router and the three graders are
 * decision-model judgments, scripted separately by QUESTION NAME
 * (`datasource`, `doc<i>`, `grounded`, `useful`) through a mock judge that
 * implements the AI SDK's decision-model spec. The retrieve/webSearch
 * actors run REAL keyword logic.
 */
function scripted(text: Record<string, unknown[]>) {
  return createMockModelExecutors({ text }).generateText;
}

/**
 * Judge answers. `relevant` scripts every `doc<i>` question through the `"*"`
 * fallback; each document name keeps its own cursor, so `[false, true]` means
 * "none relevant on the first grading, all relevant on the second".
 */
function jev(script: {
  datasource?: string;
  relevant?: MockJudgeEntry | MockJudgeEntry[];
  grounded?: MockJudgeEntry | MockJudgeEntry[];
  useful?: MockJudgeEntry | MockJudgeEntry[];
}) {
  const { relevant, ...named } = script;
  const entries: Record<string, MockJudgeEntry | MockJudgeEntry[]> = {};
  for (const [name, entry] of Object.entries(named)) if (entry !== undefined) entries[name] = entry;
  if (relevant !== undefined) entries["*"] = relevant;
  return createMockJudge(entries);
}

const toVectorstore = "vectorstore";
const toWebsearch = "websearch";

test("vectorstore route: retrieve → grade → generate → both checks pass → done", async () => {
  const result = await runAdaptiveRagExample({
    question: "How do LLM agents use long-term memory?",
    generateText: scripted({
      generateAnswer: ["Agents persist long-term memory in an external store via tools."],
    }),
    judge: jev({ datasource: toVectorstore, relevant: true, grounded: true, useful: true }).model,
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
      generateAnswer: ["Treat retrieved text as untrusted and separate privileges."],
    }),
    judge: jev({ datasource: toWebsearch, grounded: true, useful: true }).model,
  });

  expect(result.finalState).toBe("done");
  expect(result.route).toBe("websearch");
  expect(result.documents[0]).toMatch(/^\[sample web result\] Latest guidance on prompt injection/);
  expect(result.progress).not.toContain("retrieving");
  expect(result.progress).not.toContain("grading");
  expect(result.progress.slice(0, 3)).toEqual(["routing", "searchingWeb", "generating"]);
});

test("the answer prompt keeps the model from commenting on the retrieved set", async () => {
  // Web results are ungraded, so an off-topic one can reach `generateAnswer`.
  // With numbered documents the model narrated them ("Document 2 is
  // unrelated."); the prompt now lists sources unnumbered and forbids it.
  const model = createMockModelExecutors({ text: { generateAnswer: "answer" } });
  await runAdaptiveRagExample({
    question: "What is the latest guidance on defending agents against prompt injection?",
    generateText: model.generateText,
    judge: jev({ datasource: toWebsearch, grounded: true, useful: true }).model,
  });

  const [answerCall] = model.calls.filter((call) => call.name === "generateAnswer");
  expect(answerCall).toBeDefined();
  expect(answerCall!.request.system).toBe(ANSWER_SYSTEM_PROMPT);
  expect(answerCall!.request.system).toMatch(/never mention the notes/i);
  expect(answerCall!.request.system).toMatch(/silently ignore/i);
  const prompt = String(answerCall!.request.prompt);
  expect(prompt).toContain("- [sample web result] Latest guidance on prompt injection");
  expect(prompt).not.toMatch(/\[\d+\]|document \d/i);
});

test("nothing relevant → rewrite → retrieve again → answered", async () => {
  const result = await runAdaptiveRagExample({
    question: "How do agents plan hard goals?",
    generateText: scripted({
      rewriteQuestion: ["agent planning task decomposition subgoals"],
      generateAnswer: ["Agents decompose a goal into ordered subgoals."],
    }),
    judge: jev({
      datasource: toVectorstore,
      relevant: [false, true],
      grounded: true,
      useful: true,
    }).model,
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
      generateAnswer: ["Agents store memory on the moon.", "Agents persist memory externally."],
    }),
    judge: jev({
      datasource: toVectorstore,
      relevant: true,
      grounded: [false, true],
      useful: true,
    }).model,
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
      generateAnswer: ["Agents store memory on the moon."],
    }),
    judge: jev({ datasource: toVectorstore, relevant: true, grounded: false }).model,
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
      rewriteQuestion: ["long-term memory tools for LLM agents"],
      generateAnswer: ["Memory is a thing.", "A retrieval tool fetches past facts."],
    }),
    judge: jev({
      datasource: toVectorstore,
      relevant: true,
      grounded: true,
      useful: [false, true],
    }).model,
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
      rewriteQuestion: ["chain of thought prompting explained"],
    }),
    judge: jev({ datasource: toVectorstore }).model,
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
    generateText: scripted({}),
    judge: jev({ datasource: toVectorstore }).model,
  });
  // The `doc<i>` questions have no scripted answer, so the judge call throws.
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
          rewriteQuestion: [starter.input.question],
          generateAnswer: ["answer"],
        }),
        judge: jev({
          datasource: starter.label === CURRENT_EVENTS ? toWebsearch : toVectorstore,
          relevant: true,
          grounded: true,
          useful: true,
        }).model,
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

test("the router asks Jev one choice over the question and routes on the chosen label", async () => {
  const mock = jev({ datasource: toWebsearch, grounded: true, useful: true });
  const result = await runAdaptiveRagExample({
    question: "What is the latest guidance on defending agents against prompt injection?",
    generateText: scripted({ generateAnswer: ["answer"] }),
    judge: mock.model,
  });

  const routing = mock.calls[0]!;
  expect(routing.state).toEqual({
    question: "What is the latest guidance on defending agents against prompt injection?",
  });
  expect(Object.keys(routing.questions)).toEqual(["datasource"]);
  const datasource = routing.questions.datasource as { type: string; criteria: object };
  expect(datasource.type).toBe("choice");
  expect(Object.keys(datasource.criteria)).toEqual(["vectorstore", "websearch"]);
  expect(result.route).toBe("websearch");
  expect(result.progress).toContain("searchingWeb");
});

test("the document grader asks one boolean question per document and keeps only those at the threshold", async () => {
  const mock = createMockJudge({
    datasource: toVectorstore,
    doc0: RELEVANCE_THRESHOLD,
    "*": RELEVANCE_THRESHOLD - 0.01,
    grounded: true,
    useful: true,
  });
  const result = await runAdaptiveRagExample({
    question: "How do LLM agents use long-term memory?",
    generateText: scripted({ generateAnswer: ["answer"] }),
    judge: mock.model,
  });

  const grading = mock.calls[1]!;
  const documents = (grading.state as { question: string; documents: string[] }).documents;
  expect(grading.state).toMatchObject({ question: "How do LLM agents use long-term memory?" });
  expect(documents.length).toBeGreaterThan(1);
  expect(Object.keys(grading.questions)).toEqual(documents.map((_, i) => `doc${i}`));
  expect(Object.values(grading.questions).every((q) => q.type === "boolean")).toBe(true);
  expect(result.documents).toEqual([documents[0]]);
  expect(result.trail).toContain(`the grader kept 1.`);
});

test("the hallucination check asks one boolean question over documents and answer; just under the threshold regenerates", async () => {
  const mock = jev({
    datasource: toVectorstore,
    relevant: true,
    grounded: [GROUNDED_THRESHOLD - 0.01, GROUNDED_THRESHOLD],
    useful: true,
  });
  const result = await runAdaptiveRagExample({
    generateText: scripted({ generateAnswer: ["draft one", "draft two"] }),
    judge: mock.model,
  });

  const grounding = mock.calls.filter((call) => "grounded" in call.questions);
  expect(grounding).toHaveLength(2);
  expect(Object.keys(grounding[0]!.questions)).toEqual(["grounded"]);
  expect(grounding[0]!.questions.grounded!.type).toBe("boolean");
  expect(grounding[0]!.state).toEqual({ documents: result.documents, answer: "draft one" });
  expect(result.regenerations).toBe(1);
  expect(result.answer).toBe("draft two");
});

test("the usefulness check asks one boolean question over question and answer; just under the threshold rewrites", async () => {
  const mock = jev({
    datasource: toVectorstore,
    relevant: true,
    grounded: true,
    useful: [USEFUL_THRESHOLD - 0.01, USEFUL_THRESHOLD],
  });
  const result = await runAdaptiveRagExample({
    question: "How do LLM agents use long-term memory?",
    generateText: scripted({
      rewriteQuestion: ["long-term memory tools for LLM agents"],
      generateAnswer: ["draft one", "draft two"],
    }),
    judge: mock.model,
  });

  const usefulness = mock.calls.filter((call) => "useful" in call.questions);
  expect(usefulness).toHaveLength(2);
  expect(Object.keys(usefulness[0]!.questions)).toEqual(["useful"]);
  expect(usefulness[0]!.questions.useful!.type).toBe("boolean");
  expect(usefulness[0]!.state).toEqual({
    question: "How do LLM agents use long-term memory?",
    answer: "draft one",
  });
  expect(result.rewrites).toBe(1);
  expect(result.answer).toBe("draft two");
});

test("machine lints clean", () => {
  expect(() => lintAgentMachine(adaptiveRagMachine, { throw: true })).not.toThrow();
});
