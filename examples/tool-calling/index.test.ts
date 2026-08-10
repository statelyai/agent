import { expect, test } from "vitest";
import type { AgentTool } from "@statelyai/agent";
import { runToolCallingExample, validateAnswer } from "./index.js";

// Mock host: plays the adapter's tool loop for one request — picks the named
// tool off `request.tools`, executes it (REAL tool logic runs), and formats
// the result into the structured answer. Only the model call is mocked.
function executeTool(tool: AgentTool | undefined, input: unknown) {
  return typeof tool === "function" ? tool(input) : tool?.execute?.(input);
}

function mockGenerateText(toolName: string, toolInput: unknown, unit: string | null = "none") {
  return async ({ tools }: { tools?: Record<string, AgentTool | undefined> }) => {
    const result = (await executeTool(tools?.[toolName], toolInput)) as {
      value?: number;
      rate?: number;
      error?: string;
    };
    const value = result.value ?? result.rate ?? null;
    return {
      output: {
        answer: `Answer: ${JSON.stringify(result)}`,
        value,
        unit: value === null ? null : unit,
      },
    };
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

  expect(result.value).toBe(714); // real computation
  expect(result.validated).toBe(true);
  // One invoking state plus the validation branch — the tool loop is the
  // host's, not the machine's.
  expect(result.progress).toEqual(["answering", "done"]);
  expect(result.rejections).toEqual([]);
});

test("unit converter genuinely converts km to mi", async () => {
  const result = await runToolCallingExample({
    query: "How many miles is 10 km?",
    generateText: mockGenerateText("convertUnits", { value: 10, from: "km", to: "mi" }, "mi"),
  });

  expect(result.value).toBe(6.214);
  expect(result.unit).toBe("mi");
  expect(result.validated).toBe(true);
});

test("sample-data rate lookup reads the fixed table", async () => {
  const result = await runToolCallingExample({
    query: "USD to EUR rate?",
    generateText: mockGenerateText("lookupRate", { from: "USD", to: "EUR" }, "EUR"),
  });

  expect(result.value).toBe(0.92);
  expect(result.validated).toBe(true);
});

test("the request carries maxSteps metadata for the host tool loop", async () => {
  let seenMaxSteps: unknown;
  const result = await runToolCallingExample({
    query: "What is 1 plus 1?",
    generateText: async (request) => {
      seenMaxSteps = request.metadata?.maxSteps;
      const sum = (await executeTool(request.tools?.calculate, {
        operation: "add",
        a: 1,
        b: 1,
      })) as { value: number };
      return { output: { answer: "Two.", value: sum.value, unit: "none" } };
    },
  });

  expect(seenMaxSteps).toBe(5);
  expect(result.value).toBe(2);
});

test("an unbacked answer is rejected, and the retry carries the note into the prompt", async () => {
  const prompts: (string | undefined)[] = [];
  let call = 0;
  const result = await runToolCallingExample({
    query: "What is 6 times 7?",
    generateText: async (request) => {
      prompts.push(request.prompt);
      call += 1;
      // Attempt 1 guesses without calling a tool; attempt 2 uses the calculator.
      if (call === 1) return { output: { answer: "Probably 42.", value: null, unit: null } };
      const product = (await executeTool(request.tools?.calculate, {
        operation: "multiply",
        a: 6,
        b: 7,
      })) as { value: number };
      return { output: { answer: "It is 42.", value: product.value, unit: "none" } };
    },
  });

  expect(result.attempts).toBe(2);
  expect(result.validated).toBe(true);
  expect(result.value).toBe(42);
  // Transient states collapse; the second `answering` is the retry.
  expect(result.progress).toEqual(["answering", "answering", "done"]);
  expect(result.rejections).toHaveLength(1);
  expect(prompts[1]).toContain("Your last answer was rejected");
  expect(prompts[1]).toContain("No tool produced a number");
});

test("a tool denial the model cannot recover from ends in `denied`, not a throw", async () => {
  // No sample rate for USD->JPY: the tool denies the args, so no value exists.
  const result = await runToolCallingExample({
    query: "USD to JPY rate?",
    generateText: mockGenerateText("lookupRate", { from: "USD", to: "JPY" }),
  });

  expect(result.validated).toBe(false);
  expect(result.attempts).toBe(2);
  expect(result.answer).toContain("Could not answer within 2 attempts");
  expect(result.progress.at(-1)).toBe("denied");
});

test("the machine rejects a unit the tools do not deal in", () => {
  expect(validateAnswer({ answer: "3 leagues.", value: 3, unit: "leagues" })).toContain(
    "not a unit these tools deal in",
  );
  expect(validateAnswer({ answer: "714.", value: 714, unit: "none" })).toBe("");
});
