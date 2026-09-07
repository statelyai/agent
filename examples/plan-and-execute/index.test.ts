import { test } from "vitest";
import assert from "node:assert/strict";
import type { AgentTextRequest } from "@statelyai/agent";
import { MAX_STEPS, runPlanAndExecuteExample } from "./index.js";

test("plan-and-execute plans steps, gathers per-step evidence, and solves from the map", async () => {
  const workerQuestions: string[] = [];
  const output = await runPlanAndExecuteExample({
    input: { goal: "Compare two libraries." },
    executors: {
      generateText: async (request: AgentTextRequest) => {
        // Routed on the request NAME, never on the model ref or prompt text.
        if (request.name === "planTask") {
          return {
            output: {
              steps: [
                { id: "E1", question: "What is library A?" },
                { id: "E2", question: "What is library B?" },
              ],
            },
          };
        }
        if (request.name === "gatherEvidence") {
          workerQuestions.push(request.prompt ?? "");
          return { output: `evidence for: ${request.prompt}` };
        }
        // solver — its prompt embeds the whole evidence map.
        assert.ok(request.prompt?.includes("E1:"));
        assert.ok(request.prompt?.includes("E2:"));
        return { output: "final answer from evidence" };
      },
    },
  });

  // Both plan steps were executed, in order, via the worker.
  assert.deepEqual(workerQuestions, ["What is library A?", "What is library B?"]);
  // Evidence is retained per step id (the ReWOO evidence map), nested under
  // `details` so it never leads the rendered output.
  assert.deepEqual(output.details.evidence, {
    E1: "evidence for: What is library A?",
    E2: "evidence for: What is library B?",
  });
  assert.deepEqual(
    output.details.steps.map((step) => step.id),
    ["E1", "E2"],
  );
  assert.ok(output.details.answer.startsWith("final answer"));

  // The summary leads with the plan, collapses each finished step to one line,
  // and ends with the answer.
  assert.ok(output.summary.includes("E1. What is library A?"));
  assert.ok(output.summary.includes("E1. done. evidence for: What is library A?"));
  assert.ok(output.summary.trimEnd().endsWith("final answer from evidence"));
  // One progress line per step, nothing accumulated beyond that.
  const progressLines = output.summary
    .split("\n")
    .filter((line) => /^E\d\. (done|skipped)\./.test(line));
  assert.equal(progressLines.length, 2);
  // The summary always contains the answer, so it is the longest string field
  // and leads the rendered output.
  assert.ok(output.summary.length > output.details.answer.length);
});

test("an over-budget plan spends at most MAX_STEPS and then ends in `failed`", async () => {
  let workerCalls = 0;
  let solverCalls = 0;
  const planned = MAX_STEPS + 6;
  const output = await runPlanAndExecuteExample({
    input: { goal: "Overplan this." },
    executors: {
      generateText: async (request: AgentTextRequest) => {
        if (request.name === "planTask") {
          return {
            output: {
              steps: Array.from({ length: planned }, (_, index) => ({
                id: `E${index + 1}`,
                question: `Question ${index + 1}?`,
              })),
            },
          };
        }
        if (request.name === "gatherEvidence") {
          workerCalls += 1;
          return { output: "evidence" };
        }
        solverCalls += 1;
        return { output: "final answer" };
      },
    },
  });

  // The budget caps the spend...
  assert.equal(workerCalls, MAX_STEPS);
  assert.equal(Object.keys(output.details.evidence).length, MAX_STEPS);
  // ...and the run fails honestly instead of solving from a truncated plan.
  assert.equal(solverCalls, 0);
  assert.equal(output.details.answer, "");
  assert.ok(output.summary.includes("Failed"));
  assert.ok(
    output.summary.includes(`step budget exhausted: ran ${MAX_STEPS} of ${planned} planned steps`),
  );
  // The whole plan is still reported, with the unrunnable tail marked.
  assert.ok(output.summary.includes(`E${planned}. Question ${planned}? (over budget)`));
});

test("a plan that fits the budget still solves and lands in `done`", async () => {
  const output = await runPlanAndExecuteExample({
    input: { goal: "Fit the budget." },
    executors: {
      generateText: async (request: AgentTextRequest) => {
        if (request.name === "planTask") {
          return {
            output: {
              steps: Array.from({ length: MAX_STEPS }, (_, index) => ({
                id: `E${index + 1}`,
                question: `Question ${index + 1}?`,
              })),
            },
          };
        }
        if (request.name === "gatherEvidence") return { output: "evidence" };
        return { output: "final answer" };
      },
    },
  });

  // Exactly MAX_STEPS steps is the boundary case: it is spent, not exceeded.
  assert.equal(Object.keys(output.details.evidence).length, MAX_STEPS);
  assert.equal(output.details.answer, "final answer");
  assert.ok(!output.summary.includes("Failed"));
});

test("a failing solver ends in `failed`, not in a done run with an empty answer", async () => {
  const output = await runPlanAndExecuteExample({
    input: { goal: "Break the solver." },
    executors: {
      generateText: async (request: AgentTextRequest) => {
        if (request.name === "planTask") {
          return { output: { steps: [{ id: "E1", question: "What is library A?" }] } };
        }
        if (request.name === "gatherEvidence") return { output: "evidence for A" };
        throw new Error("solver offline");
      },
    },
  });

  assert.equal(output.details.answer, "");
  assert.ok(output.summary.includes("Failed"));
  assert.ok(output.summary.includes("solveTask failed: "));
  // The evidence gathered before the failure is still reported.
  assert.deepEqual(output.details.evidence, { E1: "evidence for A" });
});

test("a step whose worker errors is marked skipped and the loop continues", async () => {
  const output = await runPlanAndExecuteExample({
    input: { goal: "Skip one." },
    executors: {
      generateText: async (request: AgentTextRequest) => {
        if (request.name === "planTask") {
          return {
            output: {
              steps: [
                { id: "E1", question: "What is library A?" },
                { id: "E2", question: "What is library B?" },
              ],
            },
          };
        }
        if (request.name === "gatherEvidence") {
          if (request.prompt?.includes("library A")) throw new Error("worker offline");
          return { output: "evidence for B" };
        }
        return { output: "final answer" };
      },
    },
  });

  assert.ok(output.summary.includes("E1. skipped. worker error"));
  assert.ok(output.summary.includes("E2. done. evidence for B"));
  assert.deepEqual(output.details.evidence, { E2: "evidence for B" });
});
