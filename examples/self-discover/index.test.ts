import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { lintAgentMachine } from "@statelyai/agent/testing";
import { createMockModelExecutors } from "../mock-model.js";
import {
  MAX_SELECTED_MODULES,
  MAX_SELECTION_RETRIES,
  REASONING_MODULES,
  runSelfDiscoverExample,
  selfDiscoverMachine,
} from "./index.js";

/** Mock the model, keyed by REQUEST NAME. */
function scripted(text: Record<string, unknown[]>) {
  return createMockModelExecutors({ text });
}

const twoModules = { modules: [REASONING_MODULES[4]!, REASONING_MODULES[14]!] };
const tooMany = { modules: REASONING_MODULES.slice(0, MAX_SELECTED_MODULES + 1) };
const stages = {
  adaptModules: [{ adapted: "Split the pets by constraint; check each owner in turn." }],
  structurePlan: [{ structure: '{"Step 1: apply Alice\'s constraint": "", "Answer": ""}' }],
  solveTask: [
    {
      answer: "Alice: fish, Bob: dog, Carol: cat.",
      reasoningTrace: '{"Step 1: apply Alice\'s constraint": "fish", "Answer": "…"}',
    },
  ],
};

test("happy path: select → adapt → structure → reason → done", async () => {
  const result = await runSelfDiscoverExample({
    generateText: scripted({ selectModules: [twoModules], ...stages }).generateText,
  });

  expect(result.finalState).toBe("done");
  expect(result.answer).toMatch(/^Alice: fish, Bob: dog, Carol: cat\./);
  expect(result.answer).toContain("Reasoning (the filled-in structure)");
  expect(result.selectedModules).toEqual(twoModules.modules);
  expect(result.adaptedModules).toContain("Split the pets");
  expect(result.reasoningStructure).toContain("Step 1");
  expect(result.progress).toEqual(["selecting", "adapting", "structuring", "reasoning", "done"]);
});

test("an out-of-range selection is retried once, with feedback in the prompt", async () => {
  const executors = scripted({ selectModules: [tooMany, twoModules], ...stages });
  const result = await runSelfDiscoverExample({ generateText: executors.generateText });

  expect(result.finalState).toBe("done");
  expect(result.selectedModules).toEqual(twoModules.modules);
  expect(result.progress.filter((state) => state === "selecting")).toHaveLength(2);
  const selects = executors.calls.filter((call) => call.name === "selectModules");
  expect(selects[0]!.request.prompt).not.toContain("previous selection");
  expect(selects[1]!.request.prompt).toContain(
    `Your previous selection had ${MAX_SELECTED_MODULES + 1} module(s)`,
  );
});

test("an empty selection twice exhausts the retry → failed, never adapting", async () => {
  const result = await runSelfDiscoverExample({
    generateText: scripted({ selectModules: [{ modules: [] }], ...stages }).generateText,
  });

  expect(result.finalState).toBe("failed");
  expect(result.progress.filter((state) => state === "selecting")).toHaveLength(
    MAX_SELECTION_RETRIES + 1,
  );
  expect(result.progress).not.toContain("adapting");
  expect(result.answer).toContain("No answer. Stopped: selection still had 0 module(s)");
});

test("a failing stage lands in failed with the stages that completed", async () => {
  const result = await runSelfDiscoverExample({
    // structurePlan has no scripted answer, so the executor throws.
    generateText: scripted({
      selectModules: [twoModules],
      adaptModules: stages.adaptModules,
    }).generateText,
  });

  expect(result.finalState).toBe("failed");
  expect(result.selectedModules).toEqual(twoModules.modules);
  expect(result.adaptedModules).toContain("Split the pets");
  expect(result.reasoningStructure).toBe("");
  expect(result.answer).toContain("structurePlan failed");
});

const starters = JSON.parse(readFileSync(new URL("./metadata.json", import.meta.url), "utf8"))
  .starters as string[];

test("starters behave as their labels advertise", async () => {
  // Plain-string starters are whole tasks: each runs all four stages, and the
  // task text reaches every stage's prompt unchanged.
  expect(starters).toHaveLength(3);
  expect(starters[0]).toContain("SVG path element");
  for (const task of starters) {
    const executors = scripted({ selectModules: [twoModules], ...stages });
    const result = await runSelfDiscoverExample({ task, generateText: executors.generateText });
    expect(result.finalState).toBe("done");
    expect(executors.calls).toHaveLength(4);
    for (const call of executors.calls) expect(call.request.prompt).toContain(task);
  }
});

test("machine lints clean", () => {
  expect(() => lintAgentMachine(selfDiscoverMachine, { throw: true })).not.toThrow();
});
