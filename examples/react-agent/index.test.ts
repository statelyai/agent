import { expect, test } from "vitest";
import { reactAgentMachine, runReactAgentExample } from "./index.js";

// Mock `reasoner`: returns scripted reason-or-act decisions in order, one per
// `reasonOrAct` invocation. The tool actors themselves run REAL logic — only
// the model call is mocked.
function scriptedGenerateText(script: unknown[]) {
  let i = 0;
  return async (_request: { model: string }) => {
    const output = script[i] ?? script[script.length - 1];
    i++;
    return { output };
  };
}

test("tool-call iteration then answer — the ReAct loop", async () => {
  const result = await runReactAgentExample({
    question: "How many seconds are there in 3 days?",
    generateText: scriptedGenerateText([
      // Turn 1: look up seconds per day.
      {
        type: "tool",
        thought: "I need seconds per day.",
        tool: "lookup",
        parameters: { key: "seconds per day" },
      },
      // Turn 2: multiply 86400 * 3.
      {
        type: "tool",
        thought: "Now multiply by 3.",
        tool: "calculate",
        parameters: { operation: "multiply", a: 86400, b: 3 },
      },
      // Turn 3: answer using the observation.
      {
        type: "answer",
        thought: "Done.",
        tool: "answer",
        answer: "There are 259,200 seconds in 3 days.",
      },
    ]),
  });

  expect(result.answer).toBe("There are 259,200 seconds in 3 days.");
  // reasoning re-entered each turn — the loop is real transitions.
  expect(result.progress.filter((s) => s === "reasoning")).toHaveLength(3);
  expect(result.progress).toContain("lookingUp");
  expect(result.progress).toContain("calculating");
  expect(result.progress.at(-1)).toBe("answered");
});

test("budget exhaustion — best-effort answer, no throw", async () => {
  // Model never answers; it keeps calling a tool. The typed guard breaks the
  // loop when stepsRemaining hits 0 (the LangGraph recursion_limit analogue).
  const result = await runReactAgentExample({
    question: "Loop forever?",
    maxSteps: 2,
    generateText: scriptedGenerateText([
      {
        type: "tool",
        thought: "Looking up.",
        tool: "lookup",
        parameters: { key: "earth radius" },
      },
    ]),
  });

  // 2 model turns allowed, then exhausted.
  expect(result.progress.filter((s) => s === "reasoning")).toHaveLength(2);
  expect(result.progress.at(-1)).toBe("exhausted");
  // Best-effort: falls back to the last assistant message rather than throwing.
  expect(result.answer.length).toBeGreaterThan(0);
});

test("unknown tool name is rejected by the discriminated-union schema", async () => {
  // A hallucinated tool name can't validate into the reason-or-act union, so it
  // never reaches an actor — the request output schema is the guard.
  await expect(
    runReactAgentExample({
      question: "Use a fake tool.",
      generateText: scriptedGenerateText([
        {
          type: "tool",
          thought: "Calling something that does not exist.",
          tool: "sendEmail", // not in the union
          parameters: { to: "nobody" },
        },
      ]),
    }),
  ).rejects.toThrow();
});

test("machine exports a runnable definition", () => {
  expect(reactAgentMachine.id).toBe("react-agent");
});
