import { expect, test } from "vitest";
import { runAdaptiveRagExample } from "./index.js";

test("routes local questions through retrieval and answer grading", async () => {
  const calls: string[] = [];
  const output = await runAdaptiveRagExample({
    question: "How do durable agent workflows resume?",
    generateText: async (request) => {
      calls.push(request.model);
      if (request.model === "router") return { output: { route: "local" } };
      if (request.system?.includes("evidence can answer")) return { output: { relevant: true } };
      if (request.system?.includes("Judge whether")) {
        return { output: { grounded: true, useful: true } };
      }
      return { output: "They resume from persisted snapshots and explicit events." };
    },
  });

  expect(output.route).toBe("local");
  expect(output.documents.length).toBeGreaterThan(0);
  expect(output.answer).toContain("persisted snapshots");
  expect(calls).toEqual(["router", "grader", "writer", "grader"]);
});

test("routes web questions through search and answer grading", async () => {
  const calls: string[] = [];
  const output = await runAdaptiveRagExample({
    question: "What is the weather in Lisbon?",
    generateText: async (request) => {
      calls.push(request.model);
      if (request.model === "router") return { output: { route: "web" } };
      if (request.system?.includes("Judge whether")) {
        return { output: { grounded: true, useful: true } };
      }
      return { output: "Lisbon is mild with coastal winds." };
    },
  });

  expect(output.route).toBe("web");
  expect(output.documents.length).toBeGreaterThan(0);
  expect(output.documents.every((doc) => doc.startsWith("[web]"))).toBe(true);
  expect(output.answer).toContain("coastal winds");
  // Web route skips evidence grading; only route, generate, and answer-grade run.
  expect(calls).toEqual(["router", "writer", "grader"]);
});

test("rewrites weak local retrieval once", async () => {
  let evidenceGrades = 0;
  const output = await runAdaptiveRagExample({
    question: "Explain resumability",
    generateText: async (request) => {
      if (request.model === "router") return { output: { route: "local" } };
      if (request.system?.includes("evidence can answer")) {
        evidenceGrades++;
        return { output: { relevant: evidenceGrades > 1 } };
      }
      if (request.system?.includes("Rewrite")) return { output: "XState actors persist snapshots" };
      if (request.system?.includes("Judge whether")) {
        return { output: { grounded: true, useful: true } };
      }
      return { output: "Actors resume from snapshots." };
    },
  });

  expect(output.retries).toBe(1);
  expect(output.query).toBe("XState actors persist snapshots");
  expect(output.documents.length).toBeGreaterThan(0);
});

test("regrade failure on a web route rewrites back into web search", async () => {
  let answerGrades = 0;
  let evidenceGraded = false;
  const output = await runAdaptiveRagExample({
    question: "What is the weather in Lisbon?",
    generateText: async (request) => {
      if (request.model === "router") return { output: { route: "web" } };
      if (request.system?.includes("evidence can answer")) {
        evidenceGraded = true;
        return { output: { relevant: true } };
      }
      if (request.system?.includes("Rewrite")) return { output: "weather Lisbon forecast" };
      if (request.system?.includes("Judge whether")) {
        answerGrades++;
        return { output: { grounded: false, useful: false } };
      }
      return { output: "Lisbon stays mild with coastal winds." };
    },
  });

  expect(output.route).toBe("web");
  expect(output.retries).toBe(1);
  expect(answerGrades).toBe(2);
  // The rewrite returned to web search, so local-only evidence grading never
  // ran and every document is still a web result.
  expect(evidenceGraded).toBe(false);
  expect(output.documents.length).toBeGreaterThan(0);
  expect(output.documents.every((doc) => doc.startsWith("[web]"))).toBe(true);
});
