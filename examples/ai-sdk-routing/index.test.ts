import { test } from "vitest";
import assert from "node:assert/strict";
import { runAgent } from "@statelyai/agent";
import { aiSdkRoutingMachine, SAMPLE_POLICIES } from "./index.js";

test("AI SDK routing maps to an explicit machine", async () => {
  const routedModels: string[] = [];
  let answerPrompt: string | undefined;
  let answerSystem: string | undefined;
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
        answerPrompt = request.prompt;
        answerSystem = request.system;
        return { output: "technical:answered" };
      },
    },
  });
  assert.deepEqual(routedModels, ["complexAnswerer"]);
  assert.equal(result.status, "done");
  assert.equal(result.status === "done" ? result.output.response : undefined, "technical:answered");
  // The responder is grounded: the matching policy excerpt travels with the
  // query, and the system prompt forbids inventing policy facts.
  assert.ok(answerPrompt?.includes("The app crashes on launch."));
  assert.ok(answerPrompt?.includes(SAMPLE_POLICIES.technical));
  assert.ok(answerSystem?.includes("do not invent"));
});
