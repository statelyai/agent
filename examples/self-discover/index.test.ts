import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { lintAgentMachine } from "@statelyai/agent/testing";
import { createMockJudge, type MockJudgeEntry } from "../mock-judge.js";
import { createMockModelExecutors } from "../mock-model.js";
import {
  MAX_SELECTED_MODULES,
  MODULE_THRESHOLD,
  REASONING_MODULES,
  runSelfDiscoverExample,
  selfDiscoverMachine,
} from "./index.js";

/**
 * Mock the text model keyed by REQUEST NAME, and the module selection as Jev
 * answers keyed by QUESTION NAME (`module<i>`, one boolean question per module).
 */
function scripted(
  text: Record<string, unknown[]>,
  selection: Record<string, MockJudgeEntry | MockJudgeEntry[]> = pickTwo,
) {
  const executors = createMockModelExecutors({ text });
  const jev = createMockJudge(selection);
  return { ...executors, judge: jev.model, jev };
}

const twoModules = { modules: [REASONING_MODULES[4]!, REASONING_MODULES[14]!] };
/** Jev finds modules 4 and 14 helpful (in that order) and no others. */
const pickTwo = { module4: 0.9, module14: 0.8, "*": 0.1 };
/** Jev finds no module helpful. */
const pickNone = { "*": 0.1 };
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
    ...scripted(stages),
  });

  expect(result.finalState).toBe("done");
  expect(result.answer).toMatch(/^Alice: fish, Bob: dog, Carol: cat\./);
  expect(result.answer).toContain("Reasoning (the filled-in structure)");
  expect(result.selectedModules).toEqual(twoModules.modules);
  expect(result.adaptedModules).toContain("Split the pets");
  expect(result.reasoningStructure).toContain("Step 1");
  expect(result.progress).toEqual(["selecting", "adapting", "structuring", "reasoning", "done"]);
});

test("no module above the threshold → failed with a notice naming it, never adapting", async () => {
  const executors = scripted(stages, pickNone);
  const result = await runSelfDiscoverExample({ ...executors });

  expect(result.finalState).toBe("failed");
  // One Jev call, no retry: the same question over the same state.
  expect(executors.jev.calls).toHaveLength(1);
  expect(result.progress.filter((state) => state === "selecting")).toHaveLength(1);
  expect(result.progress).not.toContain("adapting");
  expect(result.selectedModules).toEqual([]);
  expect(result.answer).toContain(
    `No answer. Stopped: no reasoning module cleared MODULE_THRESHOLD (${MODULE_THRESHOLD})`,
  );
  expect(executors.calls).toHaveLength(0);
});

test("a failing stage lands in failed with the stages that completed", async () => {
  const result = await runSelfDiscoverExample({
    // structurePlan has no scripted answer, so the executor throws.
    ...scripted({ adaptModules: stages.adaptModules }),
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
    const executors = scripted(stages);
    const result = await runSelfDiscoverExample({ task, ...executors });
    expect(result.finalState).toBe("done");
    // select is one Jev call over the task; adapt/structure/reason are text calls.
    expect(executors.jev.calls).toHaveLength(1);
    expect(executors.jev.calls[0]!.state).toMatchObject({ task });
    expect(executors.calls).toHaveLength(3);
    for (const call of executors.calls) expect(call.request.prompt).toContain(task);
  }
});

test("select asks Jev one boolean question per module and keeps the top-k above the threshold", async () => {
  // Seven modules clear the threshold; module 7 sits just under it.
  const probabilities = [0.6, 0.95, 0.7, 0.9, 0.8, 0.65, 0.85, MODULE_THRESHOLD - 0.01];
  const selection = Object.fromEntries(probabilities.map((p, i) => [`module${i}`, p]));
  const executors = scripted(stages, { ...selection, "*": 0 });
  const result = await runSelfDiscoverExample({ ...executors });

  expect(executors.jev.calls).toHaveLength(1);
  const call = executors.jev.calls[0]!;
  // The evidence is the state: the task and every module, in order.
  expect(call.state).toMatchObject({ modules: [...REASONING_MODULES] });
  expect(Object.keys(call.questions)).toEqual(REASONING_MODULES.map((_, i) => `module${i}`));
  expect(Object.values(call.questions).every((q) => q.type === "boolean")).toBe(true);
  // Top MAX_SELECTED_MODULES by probability, most probable first.
  expect(result.selectedModules).toHaveLength(MAX_SELECTED_MODULES);
  expect(result.selectedModules).toEqual([1, 3, 6, 4, 2].map((i) => REASONING_MODULES[i]!));

  // Only the just-under module: nothing clears the bar, so the run fails.
  const under = scripted(stages, { module7: MODULE_THRESHOLD - 0.01, "*": 0 });
  const rejected = await runSelfDiscoverExample({ ...under });
  expect(rejected.finalState).toBe("failed");
  expect(rejected.progress).not.toContain("adapting");

  // At exactly the threshold, the module is kept.
  const at = scripted(stages, { module7: MODULE_THRESHOLD, "*": 0 });
  const kept = await runSelfDiscoverExample({ ...at });
  expect(kept.finalState).toBe("done");
  expect(kept.selectedModules).toEqual([REASONING_MODULES[7]!]);
});

test("machine lints clean", () => {
  expect(() => lintAgentMachine(selfDiscoverMachine, { throw: true })).not.toThrow();
});
