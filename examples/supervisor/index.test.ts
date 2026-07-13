import { test } from "vitest";
import assert from "node:assert/strict";
import type { AgentTextRequest } from "../../src/index.js";
import { runSupervisorExample } from "./index.js";

test("supervisor routes a request to one typed specialist and composes the result", async () => {
  const seenModels: string[] = [];
  const output = await runSupervisorExample({
    input: { request: "Explain how event sourcing works." },
    executors: {
      generateText: async (request: AgentTextRequest) => {
        seenModels.push(request.model);
        if (request.model === "supervisor") {
          return {
            output: { specialist: "researcher", reason: "informational question" },
          };
        }
        return { output: `[${request.model}] answered: ${request.prompt}` };
      },
    },
  });

  // The router picked "researcher", so only that specialist runs (not coder/writer).
  assert.deepEqual(seenModels, ["supervisor", "researcher"]);
  assert.equal(output.specialist, "researcher");
  assert.equal(output.reason, "informational question");
  assert.equal(output.answer, "[researcher] answered: Explain how event sourcing works.");
});
