import { test } from "vitest";
import assert from "node:assert/strict";
import type { AgentTextRequest } from "../../src/index.js";
import { runSubflowsExample } from "./index.js";

test("parent invokes the child agent machine and maps typed I/O across the boundary", async () => {
  const output = await runSubflowsExample({
    input: { topic: "actors" },
    generateText: async (request: AgentTextRequest) => ({
      output: `Research summary: ${request.prompt}`,
    }),
  });

  assert.deepEqual(output, {
    research: "Research summary: Research: actors",
  });
});
