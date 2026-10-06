import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { type AgentDecisionRequest } from "@statelyai/agent";
import { lintAgentMachine } from "@statelyai/agent/testing";
import { createMockJudge, type MockJudgeEntry } from "../mock-judge.js";
import { createMockModelExecutors, type MockModelScript } from "../mock-model.js";
import {
  MAX_RETRIEVALS,
  RELEVANCE_THRESHOLD,
  agenticRagMachine,
  runAgenticRagExample,
} from "./index.js";

/**
 * Mock only the models: text answers keyed by REQUEST NAME, the one decision
 * keyed by its explicit name `chooseAction`, and the grader's mock-judge answers keyed
 * by QUESTION NAME (`doc<i>`). The retriever actor runs REAL keyword logic over
 * the sample posts.
 */
function scripted(script: MockModelScript) {
  const { generateText, decide } = createMockModelExecutors(script);
  return { generateText, decide };
}

const retrieve = (keywords: string) => ({ type: "RETRIEVE" as const, keywords });
const answer = (text: string) => ({ type: "ANSWER" as const, answer: text });
const rewrite = (question: string) => ({ type: "REWRITE" as const, question });

/** Distinct words, so each scripted search or rewrite is a genuinely new one. */
const FRESH = ["diffusion", "video", "synthesis", "temporal", "frames", "motion", "clips"];
/** A decision entry that answers with a new search (or rewrite) on every call. */
function fresh<T>(make: (word: string) => T): () => T {
  let n = 0;
  return () => make(FRESH[n++ % FRESH.length]!);
}
/**
 * Every passage graded relevant (or not). Each `doc<i>` keeps its own cursor,
 * so `[false, true]` means "none on the first grading, all on the second".
 */
const grader = (relevant: MockJudgeEntry | MockJudgeEntry[]) =>
  createMockJudge({ "*": relevant }).model;

/** A model that obeys the guard: new searches until told it may not, then ANSWER. */
function retrieveUntilRejected() {
  const nextSearch = fresh((word) => retrieve(`agent ${word}`));
  return (request: AgentDecisionRequest) =>
    request.attempts.some((attempt) => attempt.failure === "rejected-by-guard")
      ? answer("Best guess without sources.")
      : nextSearch();
}

test("on-corpus: RETRIEVE → relevant → generate → done", async () => {
  const result = await runAgenticRagExample({
    question: "What does Lilian Weng say about the types of agent memory?",
    ...scripted({
      decisions: { chooseAction: [retrieve("agent memory types")] },
      text: { generateAnswer: ["Sensory, short-term, and long-term memory."] },
    }),
    judge: grader(true),
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
        rewriteQuestion: [rewrite("How does long-term memory work in LLM agents?")],
      },
      text: {
        generateAnswer: ["Long-term memory lives in an external vector store."],
      },
    }),
    judge: grader([false, true]),
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
      decisions: {
        chooseAction: [retrieve("diffusion video generation"), answer("Unsure.")],
        rewriteQuestion: [rewrite("Video diffusion models explained")],
      },
    }),
  });

  // The model chose to answer before the budget ran out: done, but the trail
  // says no passage backed it.
  expect(result.finalState).toBe("done");
  expect(result.progress.slice(0, 4)).toEqual(["deciding", "retrieving", "rewriting", "deciding"]);
  expect(result.progress).not.toContain("grading");
  expect(result.answeredDirectly).toBe(false);
  expect(result.trail).toContain("chose to answer without them");
  // No passage backs it, so it is labeled like the budget-forced answer.
  expect(result.answer).toBe("Unverified (no relevant passages found): Unsure.");
});

test("a RETRIEVE with blank or stop-word-only keywords fails the schema and is re-asked", async () => {
  const executors = createMockModelExecutors({
    decisions: {
      chooseAction: [retrieve(""), retrieve("what is the"), retrieve("agent memory types")],
    },
    text: { generateAnswer: ["Sensory, short-term, and long-term memory."] },
  });
  const result = await runAgenticRagExample({
    question: "What does Lilian Weng say about the types of agent memory?",
    generateText: executors.generateText,
    decide: executors.decide,
    judge: grader(true),
  });

  expect(result.finalState).toBe("done");
  expect(result.retrievals).toBe(1);
  expect(result.answer).toBe("Sensory, short-term, and long-term memory.");
  // Both bad searches were fed back with the schema's reason, not a bare guard rejection.
  const last = executors.calls.filter((call) => call.kind === "decide").at(-1)!;
  const attempts = (last.request as AgentDecisionRequest).attempts;
  expect(attempts.map((attempt) => attempt.failure)).toEqual([
    "invalid-payload",
    "invalid-payload",
  ]);
  expect(attempts[0]?.reason).toContain("at least one search word");
});

test("budget spent: the guard rejects RETRIEVE, the forced ANSWER lands in failed", async () => {
  const executors = createMockModelExecutors({
    decisions: {
      chooseAction: [retrieveUntilRejected()],
      rewriteQuestion: [fresh((word) => rewrite(`agent memory and ${word}`))],
    },
  });
  const result = await runAgenticRagExample({
    question: "What does Lilian Weng say about agent memory?",
    generateText: executors.generateText,
    decide: executors.decide,
    judge: grader(false),
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
      decisions: {
        chooseAction: [fresh((word) => retrieve(`agent ${word}`))],
        rewriteQuestion: [fresh((word) => rewrite(`agent memory and ${word}`))],
      },
    }),
    judge: grader(false),
  });

  expect(result.finalState).toBe("failed");
  expect(result.retrievals).toBe(MAX_RETRIEVALS);
  expect(result.answer).toBe("Unable to answer this question from the retrieved passages.");
  expect(result.trail).toContain("chooseAction failed");
});

type Starter = { label: string; input: { question: string } };
const starters = JSON.parse(readFileSync(new URL("./metadata.json", import.meta.url), "utf8"))
  .starters as Starter[];

test("a repeated search or a repeated rewrite is rejected, so every retry tries something new", async () => {
  const question = "What does Lilian Weng's blog say about diffusion models for video generation?";
  const executors = createMockModelExecutors({
    decisions: {
      chooseAction: [
        retrieve("Lilian Weng diffusion models video generation"),
        // Same words again (reordered, punctuated): no new word → rejected.
        retrieve("video generation, diffusion models — Lilian Weng"),
        retrieve("temporal consistency frame synthesis"),
        answer("Not covered by the posts."),
      ],
      rewriteQuestion: [
        // The original question back, then a first real rewrite.
        rewrite(question),
        rewrite("How do generative models produce video?"),
        // The first rewrite again, then a second real one.
        rewrite("How do generative models produce video?"),
        rewrite("What keeps generated video frames consistent over time?"),
      ],
    },
  });
  const result = await runAgenticRagExample({
    question,
    generateText: executors.generateText,
    decide: executors.decide,
  });

  expect(result.retrievals).toBe(2);
  expect(result.rewrites).toBe(2);
  const decisions = executors.calls.filter((call) => call.kind === "decide");
  const rejected = decisions.filter((call) =>
    (call.request as AgentDecisionRequest).attempts.some(
      (attempt) => attempt.failure === "rejected-by-guard",
    ),
  );
  // One re-ask for the repeated search, one each for the two repeated rewrites.
  expect(rejected.map((call) => call.name)).toEqual([
    "rewriteQuestion",
    "chooseAction",
    "rewriteQuestion",
  ]);
  // Both prompts carry what was already tried.
  const secondRewrite = decisions.filter((call) => call.name === "rewriteQuestion").at(-1)!;
  expect(secondRewrite.request.prompt).toContain("How do generative models produce video?");
  expect(secondRewrite.request.prompt).toContain("temporal consistency frame synthesis");
  const secondChoice = decisions.filter((call) => call.name === "chooseAction")[1]!;
  expect(secondChoice.request.prompt).toContain("Lilian Weng diffusion models video generation");
});

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
      text: { generateAnswer: ["answer"] },
    }),
    judge: grader(true),
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
        rewriteQuestion: [rewrite("How do video diffusion models generate frames?")],
      },
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

test("the grader asks Jev one boolean question per passage and keeps only those at the threshold", async () => {
  const jev = createMockJudge({ doc0: RELEVANCE_THRESHOLD, "*": RELEVANCE_THRESHOLD - 0.01 });
  const result = await runAgenticRagExample({
    question: "What does Lilian Weng say about the types of agent memory?",
    ...scripted({
      decisions: { chooseAction: [retrieve("agent memory types")] },
      text: { generateAnswer: ["answer"] },
    }),
    judge: jev.model,
  });

  expect(jev.calls).toHaveLength(1);
  const call = jev.calls[0]!;
  const state = call.state as { question: string; documents: string[] };
  expect(state.question).toBe("What does Lilian Weng say about the types of agent memory?");
  expect(state.documents.length).toBeGreaterThan(1);
  expect(Object.keys(call.questions)).toEqual(state.documents.map((_, i) => `doc${i}`));
  expect(Object.values(call.questions).every((q) => q.type === "boolean")).toBe(true);
  expect(result.trail).toContain("Answered from 1 passage(s) graded relevant");
  expect(result.progress).toContain("generating");

  // Every passage just under the threshold → rewrite instead of generate.
  const under = await runAgenticRagExample({
    question: "What does Lilian Weng say about agent memory?",
    ...scripted({
      decisions: { chooseAction: [retrieve("agent memory"), answer("Unsure.")] },
      text: { rewriteQuestion: ["agent memory, rephrased"] },
    }),
    judge: grader(RELEVANCE_THRESHOLD - 0.01),
  });
  expect(under.progress.slice(0, 4)).toEqual(["deciding", "retrieving", "grading", "rewriting"]);
});

test("machine lints clean", () => {
  expect(() => lintAgentMachine(agenticRagMachine, { throw: true })).not.toThrow();
});
