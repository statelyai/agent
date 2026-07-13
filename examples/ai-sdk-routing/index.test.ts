import { test } from "vitest";
import assert from "node:assert/strict";
import { runAgent } from "../../src/index.js";
import { aiSdkRoutingMachine } from "./index.js";

test("AI SDK routing maps to an explicit machine", async () => {
  const routedModels: string[] = [];
  const result = await runAgent(aiSdkRoutingMachine, {
    input: { query: "The app crashes on launch." },
    executors: {
      generateText: async (request) => {
        if (request.prompt?.startsWith("Classify this customer query:")) {
          return {
            output: {
              reasoning: "needs troubleshooting",
              type: "technical",
              complexity: "complex",
            },
          };
        }
        routedModels.push(request.model);
        return { output: `technical:${request.prompt}` };
      },
    },
  });
  assert.deepEqual(routedModels, ["complexAnswerer"]);
  assert.equal(result.status, "done");
  assert.equal(
    result.status === "done" ? result.output.response : undefined,
    "technical:The app crashes on launch.",
  );
});
