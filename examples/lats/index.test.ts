import { expect, test } from "vitest";
import { runLatsExample } from "./index.js";

test("expands and evaluates a tree until a solved candidate appears", async () => {
  let rollout = 0;
  const output = await runLatsExample({
    problem: "retry policy",
    generateText: async (request) => {
      if (request.model === "generator") {
        rollout++;
        return { output: { candidates: [`candidate ${rollout}a`, `candidate ${rollout}b`] } };
      }
      return {
        output: {
          evaluations:
            rollout === 1
              ? [
                  { score: 0.4, solved: false, critique: "needs idempotency" },
                  { score: 0.6, solved: false, critique: "add jitter" },
                ]
              : [
                  { score: 0.95, solved: true, critique: "complete" },
                  { score: 0.7, solved: false, critique: "unclear cap" },
                ],
        },
      };
    },
  });

  expect(rollout).toBe(2);
  expect(output.solved).toBe(true);
  expect(output.rollouts).toBe(2);
  expect(output.details.answer).toContain("candidate 2a");
  expect(output.details.nodes).toHaveLength(5);

  // The tree is rendered as indented lines: node, score, and the markers for
  // the chosen branch and the winning leaf.
  // The root carries its backpropagated score, not a candidate's.
  const treeLines = output.searchTree.split("\n");
  expect(treeLines[1]).toBe("root  (0.77)");
  expect(output.searchTree).toMatch(/^ {2}1-1 candidate 1b {2}\(0\.95\) {2}<- chosen$/m);
  expect(output.searchTree).toMatch(/^ {4}2-0 candidate 2a {2}\(0\.95\) {2}<- best$/m);
  // The winning answer sits under the tree, so the tree string always leads.
  expect(output.searchTree).toContain("Best answer (0.95, solved)");
  expect(output.searchTree.length).toBeGreaterThan(output.details.answer.length);
});

test("a confident first draft below the acceptance bar keeps the search going", async () => {
  let rollout = 0;
  const output = await runLatsExample({
    problem: "retry policy",
    generateText: async (request) => {
      if (request.model === "generator") {
        rollout++;
        return { output: { candidates: [`candidate ${rollout}a`, `candidate ${rollout}b`] } };
      }
      return {
        output: {
          evaluations:
            rollout === 1
              ? // Evaluator claims solved, but the score is under ACCEPT_SCORE:
                // the machine does not accept it, so the tree expands again.
                [
                  { score: 0.85, solved: true, critique: "no backoff cap" },
                  { score: 0.5, solved: false, critique: "no jitter" },
                ]
              : [
                  { score: 0.95, solved: true, critique: "complete" },
                  { score: 0.6, solved: false, critique: "vague" },
                ],
        },
      };
    },
  });

  // More than one expansion happened — the tree search is actually visible.
  expect(rollout).toBeGreaterThan(1);
  expect(output.solved).toBe(true);
  expect(output.details.answer).toContain("candidate 2a");
});

test("rollout budget returns the best candidate", async () => {
  const output = await runLatsExample({
    problem: "retry policy",
    generateText: async (request) =>
      request.model === "generator"
        ? { output: { candidates: ["weak", "better"] } }
        : {
            output: {
              evaluations: [
                { score: 0.2, solved: false, critique: "weak" },
                { score: 0.8, solved: false, critique: "best available" },
              ],
            },
          },
  });

  expect(output.solved).toBe(false);
  expect(output.details.answer).toContain("better");
  // Budget exhausted rather than solved, and the tree says so.
  expect(output.searchTree).toContain("budget reached");
});
