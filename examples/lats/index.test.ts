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
  expect(output.answer).toContain("candidate 2a");
  expect(output.nodes).toHaveLength(5);
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
  expect(output.answer).toContain("better");
});
