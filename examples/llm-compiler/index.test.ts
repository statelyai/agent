import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { type AgentRequestExecutors } from "@statelyai/agent";
import { lintAgentMachine } from "@statelyai/agent/testing";
import { createMockModelExecutors } from "../mock-model.js";
import {
  MAX_REPLANS,
  MAX_TASKS,
  dependenciesOf,
  evaluateArithmetic,
  llmCompilerMachine,
  planProblem,
  runLlmCompilerExample,
} from "./index.js";

/**
 * Only the model is mocked, keyed by REQUEST NAME (`plan` / `join`). The
 * `runTool` children run the real sample search and the real arithmetic
 * evaluator, so waves and `$N` substitution are exercised for real.
 */
type Task = { tool: "search" | "math" | "finish"; args: string };

const combinedPopulationPlan: { tasks: Task[] } = {
  tasks: [
    { tool: "search", args: "France population" },
    { tool: "search", args: "Germany population" },
    { tool: "math", args: "$1 + $2" },
    { tool: "finish", args: "$3 million people" },
  ],
};

const finish = (answer: string) => ({ action: "finish", answer, feedback: null });
const replan = (feedback: string) => ({ action: "replan", answer: null, feedback });

test("independent searches share a wave; the dependent math waits for both", async () => {
  const result = await runLlmCompilerExample({
    generateText: createMockModelExecutors({
      text: { plan: [combinedPopulationPlan], join: [finish("About 152.9 million people.")] },
    }).generateText,
  });

  expect(result.progress.at(-1)).toBe("done");
  expect(result.answer).toBe("About 152.9 million people.");
  expect(result.plans).toBe(1);
  expect(result.tasksRun).toBe(4);
  expect(result.waves).toBe(3);

  const waveOf = (taskId: number) => result.schedule.find((entry) => entry.taskId === taskId)!.wave;
  // $1 and $2 have no dependencies: spawned together in wave 1.
  expect(waveOf(1)).toBe(1);
  expect(waveOf(2)).toBe(1);
  // $3 started only after BOTH landed: a later wave, and its args carry both
  // substituted values (a $N left unresolved would still read "$1").
  expect(waveOf(3)).toBe(2);
  const math = result.schedule.find((entry) => entry.taskId === 3)!;
  expect(math.args).toBe("68.4 + 84.5");
  expect(math.result?.observation).toBe("[math] 68.4 + 84.5 = 152.9");
  expect(waveOf(4)).toBe(3);
  expect(result.schedule.find((entry) => entry.taskId === 4)!.args).toBe("152.9 million people");

  // `dispatching` is transient (it spawns, then moves on), so the settled
  // trajectory shows the planner, the collector, and the joiner.
  expect(result.progress).toEqual(expect.arrayContaining(["planning", "collecting", "joining"]));
  expect(result.progress.indexOf("joining")).toBeGreaterThan(
    result.progress.lastIndexOf("collecting"),
  );
  expect(result.trail).toContain(
    "wave 1: $1 search(France population) → [sample search] France population: 68.4",
  );
});

test("an invalid plan is rejected by the machine and replanned with the problem as feedback", async () => {
  const scripted = createMockModelExecutors({
    text: {
      plan: [
        {
          tasks: [
            { tool: "math", args: "$2 + 1" },
            { tool: "search", args: "Germany population" },
          ],
        },
        combinedPopulationPlan,
      ],
      join: [finish("About 152.9 million people.")],
    },
  });
  const result = await runLlmCompilerExample({ generateText: scripted.generateText });

  expect(result.progress.at(-1)).toBe("done");
  expect(result.plans).toBe(2);
  // Nothing from the invalid plan ever ran.
  expect(result.schedule.every((entry) => entry.plan === 2)).toBe(true);
  expect(result.trail).toContain(
    "Plan 1:\n  (not executed)\n  abandoned: invalid plan: task 1 references $2, which is not an earlier task",
  );
  const replanCall = scripted.calls.filter((call) => call.name === "plan")[1]!;
  expect((replanCall.input as { feedback: string }).feedback).toContain(
    "task 1 references $2, which is not an earlier task",
  );
});

test("dependencies are the $N references; planProblem rejects empty, oversized and non-backward plans", () => {
  expect(planProblem(combinedPopulationPlan.tasks)).toBeNull();
  expect(dependenciesOf({ tool: "math", args: "$1 + ${2} - $1" })).toEqual([1, 2]);
  expect(dependenciesOf({ tool: "search", args: "France population" })).toEqual([]);
  expect(planProblem([])).toBe("the plan is empty");
  expect(
    planProblem(
      Array.from({ length: MAX_TASKS + 1 }, () => ({ tool: "search", args: "x" }) as Task),
    ),
  ).toBe(`the plan has ${MAX_TASKS + 1} tasks; at most ${MAX_TASKS} are allowed`);
  // Forward reference.
  expect(
    planProblem([
      { tool: "math", args: "$2 + 1" },
      { tool: "search", args: "Japan GDP" },
    ]),
  ).toBe("task 1 references $2, which is not an earlier task");
  // Self reference, and $0.
  expect(
    planProblem([
      { tool: "search", args: "Japan GDP" },
      { tool: "math", args: "$2 * 2" },
    ]),
  ).toBe("task 2 references $2, which is not an earlier task");
  expect(planProblem([{ tool: "math", args: "$0" }])).toBe(
    "task 1 references $0, which is not an earlier task",
  );
});

test("joiner replan loops back to the planner with feedback, then finishes", async () => {
  const scripted = createMockModelExecutors({
    text: {
      plan: [{ tasks: [{ tool: "search", args: "Spain population" }] }, combinedPopulationPlan],
      join: [replan("Search France and Germany separately, then add."), finish("152.9 million")],
    },
  });
  const result = await runLlmCompilerExample({ generateText: scripted.generateText });

  expect(result.progress.at(-1)).toBe("done");
  expect(result.plans).toBe(2);
  expect(result.tasksRun).toBe(5);
  expect(result.trail).toContain('[sample search] No sample fact matches "Spain population".');
  expect(result.trail).toContain("abandoned: joiner: Search France and Germany separately");
  const secondPlan = scripted.calls.filter((call) => call.name === "plan")[1]!;
  expect((secondPlan.input as { previous: string }).previous).toContain("Plan 1:");
});

test("replan budget exhausted → failed, with the trail kept", async () => {
  const scripted = createMockModelExecutors({
    text: { plan: [combinedPopulationPlan], join: [replan("Try again.")] },
  });
  const result = await runLlmCompilerExample({ generateText: scripted.generateText });

  expect(result.progress.at(-1)).toBe("failed");
  expect(result.plans).toBe(1 + MAX_REPLANS);
  expect(scripted.calls.filter((call) => call.name === "join")).toHaveLength(1 + MAX_REPLANS);
  expect(result.answer).toBe(
    `No answer: the joiner still asked to replan after ${MAX_REPLANS} replans.`,
  );
  expect(result.tasksRun).toBe(4 * (1 + MAX_REPLANS));
  expect(result.trail).toContain(`Plan ${1 + MAX_REPLANS}:`);
});

test("invalid plans also spend the budget → failed with nothing executed", async () => {
  const result = await runLlmCompilerExample({
    generateText: createMockModelExecutors({
      text: { plan: [{ tasks: [{ tool: "math", args: "$1" }] }] },
    }).generateText,
  });
  expect(result.progress.at(-1)).toBe("failed");
  expect(result.plans).toBe(1 + MAX_REPLANS);
  expect(result.tasksRun).toBe(0);
  expect(result.answer).toContain("invalid plan after 2 replans");
});

test("a tool error is an observation the joiner sees, not a crash", async () => {
  const scripted = createMockModelExecutors({
    text: {
      plan: [
        {
          tasks: [
            { tool: "search", args: "France population" },
            { tool: "math", args: "$1 / 0" },
          ],
        },
      ],
      join: [finish("France has about 68.4 million people; the division was invalid.")],
    },
  });
  const result = await runLlmCompilerExample({ generateText: scripted.generateText });

  expect(result.progress.at(-1)).toBe("done");
  const joinCall = scripted.calls.find((call) => call.name === "join")!;
  expect((joinCall.input as { observations: string }).observations).toContain(
    "$2 math(68.4 / 0) → [tool error] division by zero",
  );
});

test("planner or joiner errors land in failed", async () => {
  const plannerDown: AgentRequestExecutors["generateText"] = async () => {
    throw new Error("planner offline");
  };
  const failedPlan = await runLlmCompilerExample({ generateText: plannerDown });
  expect(failedPlan.progress.at(-1)).toBe("failed");
  expect(failedPlan.answer).toContain("planner failed");

  const joinerDown: AgentRequestExecutors["generateText"] = async (request) => {
    if (request.name === "join") throw new Error("joiner offline");
    return { result: combinedPopulationPlan };
  };
  const failedJoin = await runLlmCompilerExample({ generateText: joinerDown });
  expect(failedJoin.progress.at(-1)).toBe("failed");
  expect(failedJoin.answer).toContain("joiner failed");
  expect(failedJoin.tasksRun).toBe(4);
});

test("the math tool is a real evaluator, not eval", () => {
  expect(evaluateArithmetic("2 * (3 + 4) - -1")).toBe(15);
  expect(evaluateArithmetic("124.5 - 14.1")).toBeCloseTo(110.4);
  expect(() => evaluateArithmetic("1 / 0")).toThrow("division by zero");
  expect(() => evaluateArithmetic("process.exit(1)")).toThrow();
  expect(() => evaluateArithmetic("2 +")).toThrow("end of input");
  expect(() => evaluateArithmetic("(1 + 2")).toThrow("parenthesis");
});

test("starters behave as their labels advertise", async () => {
  const starters = JSON.parse(readFileSync(new URL("./metadata.json", import.meta.url), "utf8"))
    .starters as string[];
  // The plan a competent planner writes for each starter: two independent
  // lookups, then one arithmetic step over both.
  const plans: Record<string, [string, string, string]> = {
    "What is the combined population of France and Germany?": [
      "France population",
      "Germany population",
      "$1 + $2",
    ],
    "How much larger is Japan's GDP than France's GDP?": ["Japan GDP", "France GDP", "$1 - $2"],
    "What percentage of Japan's population lives in Tokyo?": [
      "Tokyo population",
      "Japan population",
      "$1 / $2 * 100",
    ],
  };
  expect([...starters].sort()).toEqual(Object.keys(plans).sort());

  for (const starter of starters) {
    const [first, second, math] = plans[starter]!;
    const result = await runLlmCompilerExample({
      question: starter,
      generateText: createMockModelExecutors({
        text: {
          plan: [
            {
              tasks: [
                { tool: "search", args: first },
                { tool: "search", args: second },
                { tool: "math", args: math },
              ],
            },
          ],
          join: [finish("answer")],
        },
      }).generateText,
    });
    expect(result.progress.at(-1)).toBe("done");
    // The sample facts table answers both lookups, in parallel, and the math
    // runs on the substituted numbers.
    expect(result.trail).not.toContain("No sample fact");
    expect(result.trail).not.toContain("[tool error]");
    expect(result.schedule.map((entry) => entry.wave)).toEqual([1, 1, 2]);
  }
});

test("machine lints clean", () => {
  lintAgentMachine(llmCompilerMachine, { throw: true, warnings: true });
});
