import { test } from "vitest";
import assert from "node:assert/strict";
import { runAgent } from "@statelyai/agent";
import { aiSdkParallelReviewMachine } from "./index.js";

test("AI SDK parallel review fans out to three aspect reviews then summarizes", async () => {
  const seen: string[] = [];
  const result = await runAgent(aiSdkParallelReviewMachine, {
    input: { code: "const x = eval(input);" },
    executors: {
      generateText: async (request) => {
        const system = request.system ?? "";
        // Route the summarize call by its prompt (a JSON array of reviews).
        if (system.startsWith("Summarize")) {
          const reviews = JSON.parse(request.prompt ?? "[]") as Array<{ type: string }>;
          return {
            output: reviews
              .map((review) => review.type)
              .sort()
              .join(","),
          };
        }
        // Each aspect reviewer returns findings + severity; tag which ran.
        if (system.startsWith("You are a security reviewer")) {
          seen.push("security");
          return { output: { findings: ["unsafe eval"], severity: "high" } };
        }
        if (system.startsWith("You are a performance reviewer")) {
          seen.push("performance");
          return { output: { findings: [], severity: "low" } };
        }
        seen.push("maintainability");
        return { output: { findings: ["unclear name x"], severity: "medium" } };
      },
    },
  });

  assert.equal(result.status, "done");
  assert.deepEqual(seen.sort(), ["maintainability", "performance", "security"]);
  assert.equal(
    result.status === "done" ? result.output.summary : undefined,
    "maintainability,performance,security",
  );
  assert.equal(result.status === "done" ? result.output.reviews.length : 0, 3);
});
