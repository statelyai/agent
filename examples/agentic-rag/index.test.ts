import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { type AgentDecisionRequest } from "@statelyai/agent";
import { lintAgentMachine } from "@statelyai/agent/testing";
import { createMockModelExecutors, type MockModelScript } from "../mock-model.js";
import { MAX_RETRIEVALS, agenticRagMachine, runAgenticRagExample } from "./index.js";

/**
 * Mock only the model: text answers keyed by REQUEST NAME, and the one
 * decision keyed by its explicit name `chooseAction`. The retriever actor runs
 * REAL keyword logic over the sample posts.
 */
function scripted(script: MockModelScript) {
  const { generateText, decide } = createMockModelExecutors(script);
  return { generateText, decide };
}

const retrieve = (keywords: string) => ({ type: "RETRIEVE" as const, keywords });
const answer = (text: string) => ({ type: "ANSWER" as const, answer: text });
/** A model that obeys the guard: RETRIEVE until told it may not, then ANSWER. */
const retrieveUntilRejected = (request: AgentDecisionRequest) =>
  request.attempts.some((attempt) => attempt.failure === "rejected-by-guard")
    ? answer("Best guess without sources.")
    : retrieve("diffusion video");

test("on-corpus: RETRIEVE → relevant → generate → done", async () => {
  const result = await runAgenticRagExample({
    question: "What does Lilian Weng say about the types of agent memory?",
    ...scripted({
      decisions: { chooseAction: [retrieve("agent memory types")] },
      text: {
        gradeDocuments: [{ relevant: true }],
        generateAnswer: ["Sensory, short-term, and long-term memory."],
      },
    }),
  });

  expect(result.finalState).toBe("done");
  expect(result.answer).toBe("Sensory, short-term, and long-term memory.");
  expect(result.retrievals).toBe(1);
  expect(result.answeredDirectly).toBe(false);
  expect(result.trail).toContain("passage(s) graded relevant");
  expect(result.progress).toEqual(["deciding", "retrieving", "grading", "generating", "done"]);
});

test("ANSWER before any retrieval is the direct path", async () => {
  const result = await runAgenticRagExample({
    question: "What is 2+2?",
    ...scripted({ decisions: { chooseAction: [answer("4")] } }),
  });

  expect(result.finalState).toBe("done");
  expect(result.answer).toBe("4");
  expect(result.answeredDirectly).toBe(true);
  expect(result.retrievals).toBe(0);
  expect(result.progress).toEqual(["deciding", "done"]);
});

test("graded irrelevant → rewrite → the model retrieves again → done", async () => {
  const result = await runAgenticRagExample({
    question: "How do agents remember things?",
    ...scripted({
      decisions: {
        chooseAction: [retrieve("agent memory"), retrieve("long-term memory vector store")],
      },
      text: {
        gradeDocuments: [{ relevant: false }, { relevant: true }],
        rewriteQuestion: ["How does long-term memory work in LLM agents?"],
        generateAnswer: ["Long-term memory lives in an external vector store."],
      },
    }),
  });

  expect(result.finalState).toBe("done");
  expect(result.retrievals).toBe(2);
  expect(result.rewrites).toBe(1);
  expect(result.progress).toEqual([
    "deciding",
    "retrieving",
    "grading",
    "rewriting",
    "deciding",
    "retrieving",
    "grading",
    "generating",
    "done",
  ]);
});

test("empty retrieval skips grading and goes straight to the rewrite", async () => {
  const result = await runAgenticRagExample({
    question: "What does Lilian Weng's blog say about diffusion models for video generation?",
    ...scripted({
      decisions: { chooseAction: [retrieve("diffusion video generation"), answer("Unsure.")] },
      text: { rewriteQuestion: ["Video diffusion models explained"] },
    }),
  });

  // The model chose to answer before the budget ran out: done, but the trail
  // says no passage backed it.
  expect(result.finalState).toBe("done");
  expect(result.progress.slice(0, 4)).toEqual(["deciding", "retrieving", "rewriting", "deciding"]);
  expect(result.progress).not.toContain("grading");
  expect(result.answeredDirectly).toBe(false);
  expect(result.trail).toContain("chose to answer without them");
});

test("budget spent: the guard rejects RETRIEVE, the forced ANSWER lands in failed", async () => {
  const executors = createMockModelExecutors({
    decisions: { chooseAction: [retrieveUntilRejected] },
    text: {
      gradeDocuments: [{ relevant: false }],
      rewriteQuestion: ["agent memory, rephrased"],
    },
  });
  const result = await runAgenticRagExample({
    question: "What does Lilian Weng say about agent memory?",
    generateText: executors.generateText,
    decide: executors.decide,
  });

  expect(result.finalState).toBe("failed");
  expect(result.retrievals).toBe(MAX_RETRIEVALS);
  expect(result.progress.filter((state) => state === "retrieving")).toHaveLength(MAX_RETRIEVALS);
  expect(result.answer).toBe(
    "Unverified (no relevant passages found): Best guess without sources.",
  );
  expect(result.trail).toContain("retrieval budget exhausted");
  // The last decision was retried after its RETRIEVE was rejected by the guard.
  const last = executors.calls.filter((call) => call.kind === "decide").at(-1)!;
  expect((last.request as AgentDecisionRequest).attempts[0]?.failure).toBe("rejected-by-guard");
});

test("a model that keeps choosing RETRIEVE past the budget exhausts the decision → failed", async () => {
  const result = await runAgenticRagExample({
    question: "What does Lilian Weng say about agent memory?",
    ...scripted({
      decisions: { chooseAction: [retrieve("agent memory")] },
      text: {
        gradeDocuments: [{ relevant: false }],
        rewriteQuestion: ["agent memory, rephrased"],
      },
    }),
  });

  expect(result.finalState).toBe("failed");
  expect(result.retrievals).toBe(MAX_RETRIEVALS);
  expect(result.answer).toBe("Unable to answer this question from the retrieved passages.");
  expect(result.trail).toContain("chooseAction failed");
});

type Starter = { label: string; input: { question: string } };
const starters = JSON.parse(readFileSync(new URL("./metadata.json", import.meta.url), "utf8"))
  .starters as Starter[];

test("starters behave as their labels advertise", async () => {
  const [onCorpus, offCorpus, trivial] = starters;
  expect(onCorpus!.label).toMatch(/^On-corpus/);
  expect(offCorpus!.label).toMatch(/^Off-corpus/);
  expect(trivial!.label).toMatch(/^Trivial/);

  // On-corpus: a search with the question's own words hits the memory post.
  const hit = await runAgenticRagExample({
    question: onCorpus!.input.question,
    ...scripted({
      decisions: { chooseAction: [retrieve(onCorpus!.input.question)] },
      text: { gradeDocuments: [{ relevant: true }], generateAnswer: ["answer"] },
    }),
  });
  expect(hit.finalState).toBe("done");
  expect(hit.progress).toContain("generating");

  // Off-corpus: the same search finds nothing at all, whatever the grader
  // would say, so the run goes straight to a rewrite.
  const miss = await runAgenticRagExample({
    question: offCorpus!.input.question,
    ...scripted({
      decisions: {
        chooseAction: [retrieve(offCorpus!.input.question), answer("Not covered.")],
      },
      text: { rewriteQuestion: [offCorpus!.input.question] },
    }),
  });
  expect(miss.progress.slice(0, 3)).toEqual(["deciding", "retrieving", "rewriting"]);
  expect(miss.progress).not.toContain("grading");

  // Trivial: answering directly never touches the retriever.
  const direct = await runAgenticRagExample({
    question: trivial!.input.question,
    ...scripted({ decisions: { chooseAction: [answer("4")] } }),
  });
  expect(direct.answeredDirectly).toBe(true);
  expect(direct.progress).toEqual(["deciding", "done"]);
});

test("machine lints clean", () => {
  expect(() => lintAgentMachine(agenticRagMachine, { throw: true })).not.toThrow();
});
