import { expect, test } from "vitest";
import { codeAssistantMachine, executeCode, runCodeAssistantExample } from "./index.js";

// Mock the model: return scripted `{ code, explanation }` outputs in call order,
// one per `generateCode` invocation. The runChecks actor runs REAL vm execution
// — only the model call is mocked. Each generation's resolved prompt is captured
// so tests can assert the reflected failures were fed back.
function scriptedGenerateText(codes: string[]) {
  const prompts: string[] = [];
  let i = 0;
  const generateText = async (request: { prompt?: string }) => {
    prompts.push(request.prompt ?? "");
    const code = codes[i] ?? codes[codes.length - 1]!;
    i++;
    return { output: { code, explanation: "" } };
  };
  return { generateText, prompts };
}

const SUM_TASK = {
  spec: "Sum an array of numbers.",
  functionName: "sumArray",
  checks: [
    { args: [[1, 2, 3]], expected: 6 },
    { args: [[]], expected: 0 },
  ],
};

// The seeded bug: `reduce` with no initial value throws on an empty array.
const SEEDED_BUG = "function sumArray(xs) { return xs.reduce((a, b) => a + b); }";

test("first generation fails a check, second passes → attempts === 2, failure fed back", async () => {
  // v1 forgets the empty-array case (returns undefined → NaN); v2 is correct.
  const brokenSum = "function sumArray(xs) { return xs.reduce((a, b) => a + b); }";
  const correctSum = "function sumArray(xs) { return xs.reduce((a, b) => a + b, 0); }";
  const { generateText, prompts } = scriptedGenerateText([brokenSum, correctSum]);

  const result = await runCodeAssistantExample({ ...SUM_TASK, generateText });

  expect(result.passed).toBe(true);
  expect(result.attempts).toBe(2);
  // The generate→execute loop ran twice before succeeding (the correction pass).
  expect(result.progress.filter((state) => state === "generating")).toHaveLength(2);
  expect(result.progress.at(-1)).toBe("done");
  // The exact failure from attempt 1 appeared in attempt 2's generate prompt.
  expect(prompts).toHaveLength(2);
  expect(prompts[1]).toContain("sumArray([])");
  expect(prompts[1]).toContain(brokenSum);
});

test("always-failing code → passed:false after maxAttempts, no throw", async () => {
  // Always returns the wrong value; never satisfies the checks.
  const wrong = "function sumArray() { return -1; }";
  const { generateText } = scriptedGenerateText([wrong]);

  const result = await runCodeAssistantExample({
    ...SUM_TASK,
    maxAttempts: 3,
    generateText,
  });

  expect(result.passed).toBe(false);
  expect(result.attempts).toBe(3);
  expect(result.failures.length).toBeGreaterThan(0);
  expect(result.progress.at(-1)).toBe("failed");
});

test("executeCode treats a syntax error as a normal failure, not a rejection", () => {
  const result = executeCode(
    "function sumArray(xs) { return xs.reduce((a b) => a + b; }",
    "sumArray",
    [{ args: [[1, 2]], expected: 3 }],
  );

  expect(result.passed).toBe(false);
  expect(result.failures[0]).toContain("failed to load");
});

test("seeded buggy code fails verification first, then the repair passes on rerun", async () => {
  const correctSum = "function sumArray(xs) { return xs.reduce((a, b) => a + b, 0); }";
  const { generateText, prompts } = scriptedGenerateText([correctSum]);

  const result = await runCodeAssistantExample({
    ...SUM_TASK,
    initialCode: SEEDED_BUG,
    generateText,
  });

  // Attempt 1 verified the SEEDED code — no generation ran before it.
  expect(result.progress[0]).toBe("executing");
  expect(result.progress.filter((state) => state === "generating")).toHaveLength(1);
  expect(result.passed).toBe(true);
  expect(result.attempts).toBe(2);

  // The trail reads: failing check → repair → passing rerun.
  expect(result.notes[0]).toContain("Verifying the supplied `sumArray`");
  expect(result.notes[1]).toContain("Attempt 1");
  expect(result.notes[1]).toContain("sumArray([])");
  expect(result.notes.at(-1)).toContain("Rerun after the repair");
  expect(result.summary).toContain("all 2 checks passed on attempt 2");

  // The single generation was a repair: it saw the seeded code and its failure.
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toContain(SEEDED_BUG);
  expect(prompts[0]).toContain("sumArray([])");
});

test("machine exports a runnable definition", () => {
  expect(codeAssistantMachine.id).toBe("code-assistant");
});
