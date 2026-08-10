import { test } from "vitest";
import assert from "node:assert/strict";
import type { AgentTextRequest } from "@statelyai/agent";
import { runPlanAndExecuteExample } from "./index.js";

test("plan-and-execute plans steps, gathers per-step evidence, and solves from the map", async () => {
  const workerQuestions: string[] = [];
  const output = await runPlanAndExecuteExample({
    input: { goal: "Compare two libraries." },
    executors: {
      generateText: async (request: AgentTextRequest) => {
        if (request.model === "planner") {
          return {
            output: {
              steps: [
                { id: "E1", question: "What is library A?" },
                { id: "E2", question: "What is library B?" },
              ],
            },
          };
        }
        if (request.model === "worker") {
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
