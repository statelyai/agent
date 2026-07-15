import { expect, test } from "vitest";
import type { AgentTool } from "../../src/index.js";
import { runToolCallingExample } from "./index.js";

// Mock host: plays the adapter's tool loop for one request — picks the named
// tool off `request.tools`, executes it (REAL tool logic runs), and formats
// the result into the final answer. Only the model call is mocked.
function executeTool(tool: AgentTool | undefined, input: unknown) {
  return typeof tool === "function" ? tool(input) : tool?.execute?.(input);
}

function mockGenerateText(toolName: string, toolInput: unknown) {
  return async ({ tools }: { tools?: Record<string, AgentTool | undefined> }) => {
    const result = await executeTool(tools?.[toolName], toolInput);
    return { output: `Answer: ${JSON.stringify(result)}` };
  };
}

test("calculator tool genuinely computes and progress is surfaced", async () => {
  const result = await runToolCallingExample({
    query: "What is 42 times 17?",
    generateText: mockGenerateText("calculate", {
      operation: "multiply",
      a: 42,
      b: 17,
    }),
  });

  expect(result.finalAnswer).toBe('Answer: {"value":714}'); // real computation
  // One invoking state — the tool loop is the host's, not the machine's.
  expect(result.progress).toEqual(["answering", "done"]);
});

test("unit converter genuinely converts km to mi", async () => {
  const result = await runToolCallingExample({
    query: "How many miles is 10 km?",
    generateText: mockGenerateText("convertUnits", {
      value: 10,
      from: "km",
      to: "mi",
    }),
  });

  expect(result.finalAnswer).toBe('Answer: {"value":6.214,"unit":"mi"}');
});

test("sample-data rate lookup reads the fixed table", async () => {
  const result = await runToolCallingExample({
    query: "USD to EUR rate?",
    generateText: mockGenerateText("lookupRate", { from: "USD", to: "EUR" }),
  });

  expect(result.finalAnswer).toBe('Answer: {"rate":0.92}');
});

test("the request carries maxSteps metadata for the host tool loop", async () => {
  let seenMaxSteps: unknown;
  const result = await runToolCallingExample({
    query: "What is 1 plus 1?",
    generateText: async (request) => {
      seenMaxSteps = request.metadata?.maxSteps;
      const sum = await executeTool(request.tools?.calculate, {
        operation: "add",
        a: 1,
        b: 1,
      });
      return { output: `Answer: ${JSON.stringify(sum)}` };
    },
  });

  expect(seenMaxSteps).toBe(5);
  expect(result.finalAnswer).toBe('Answer: {"value":2}');
});
