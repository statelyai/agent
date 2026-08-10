import { test } from "vitest";
import assert from "node:assert/strict";
import type { AgentTextRequest } from "@statelyai/agent";
import { runSubflowsExample } from "./index.js";

test("parent invokes the child agent machine and maps typed I/O across the boundary", async () => {
  const output = await runSubflowsExample({
    input: { topic: "actors" },
    generateText: async (request: AgentTextRequest) => ({
      output: `Research summary: ${request.prompt}`,
    }),
  });

  assert.equal(output.research, "Research summary: Research: actors");
  // The boundary is readable without digging through the trace.
  assert.equal(
    output.sentToChild,
    'Parent invoked "subflows-child" with input { topic: "actors" }.',
  );
  assert.equal(
    output.childReturned,
    "Child finished and returned its declared output { research: string } (34 chars).",
  );
  assert.equal(
    output.parentNext,
    "Parent mapped research onto its own context and reached its final state.",
  );
});
