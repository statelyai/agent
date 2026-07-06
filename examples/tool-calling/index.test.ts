import { expect, test } from "vitest";
import { runToolCallingExample } from "./index.js";

// Mock model: `router` picks the tool, `formatter` echoes the summary.
// The tool actors themselves run REAL logic — only model calls are mocked.
function mockGenerateText(selection: unknown) {
  return async ({ model, prompt }: { model: string; prompt?: string }) => {
    if (model === "router") {
      return { output: selection };
    }
    // formatter: prompt's second line is `Tool result: ...`
    const summary = (prompt ?? "").split("\n")[1]?.replace("Tool result: ", "") ?? "";
    return { output: `Answer: ${summary}` };
  };
}

test("calculator tool genuinely computes and progress is surfaced", async () => {
  const result = await runToolCallingExample({
    query: "What is 42 times 17?",
    generateText: mockGenerateText({
      tool: "calculate",
      parameters: { operation: "multiply", a: 42, b: 17 },
    }),
  });

  expect(result.tool).toBe("calculate");
  expect(result.result.value).toBe(714); // real computation
  expect(result.finalAnswer).toBe("Answer: 42 multiply 17 = 714");
  // `dispatch` is a transient choice state — passed through, not observed.
  expect(result.progress).toEqual(["selectingTool", "calculating", "formatting", "done"]);
});

test("unit converter genuinely converts km to mi", async () => {
  const result = await runToolCallingExample({
    query: "How many miles is 10 km?",
    generateText: mockGenerateText({
      tool: "convertUnits",
      parameters: { value: 10, from: "km", to: "mi" },
    }),
  });

  expect(result.tool).toBe("convertUnits");
  expect(result.result.value).toBeCloseTo(6.214, 2); // real conversion
  expect(result.progress).toContain("converting");
});

test("sample-data rate lookup reads the fixed table", async () => {
  const result = await runToolCallingExample({
    query: "USD to EUR rate?",
    generateText: mockGenerateText({
      tool: "lookupRate",
      parameters: { from: "USD", to: "EUR" },
    }),
  });

  expect(result.tool).toBe("lookupRate");
  expect(result.result.value).toBe(0.92);
  expect(result.progress).toContain("lookingUp");
});
