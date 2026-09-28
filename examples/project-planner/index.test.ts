import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { lintAgentMachine } from "@statelyai/agent/testing";
import { createMockJudge } from "../mock-judge.js";
import { createMockModelExecutors } from "../mock-model.js";
import {
  MAX_REGENERATIONS,
  MAX_REPLANS,
  MAX_TASKS,
  criticalPath,
  graphProblems,
  projectPlannerMachine,
  runProjectPlannerExample,
  type PlannedTask,
} from "./index.js";

const task = (id: string, days: number, dependsOn: string[] = []): PlannedTask => ({
  id,
  name: `Task ${id}`,
  days,
  dependsOn,
});

/** 25 days on the critical path: T1(5) → T2(10) → T4(10); T3(3) runs beside T2. */
const slowPlan = {
  tasks: [
    task("T1", 5),
    task("T2", 10, ["T1"]),
    task("T3", 3, ["T1"]),
    task("T4", 10, ["T2", "T3"]),
  ],
};
/** 8 days: everything after T1 runs in parallel. */
const fastPlan = {
  tasks: [task("T1", 3), task("T2", 5, ["T1"]), task("T3", 3, ["T1"]), task("T4", 4, ["T1"])],
};
const cyclicPlan = { tasks: [task("T1", 2, ["T2"]), task("T2", 2, ["T1"])] };
const mitigation = { mitigation: "Parallelize testing." };

/** Mock ONLY the model, by request name; validation and scheduling run for real. */
function scripted(text: Record<string, unknown[]>) {
  return createMockModelExecutors({ text: { suggestMitigation: [mitigation], ...text } });
}

/** The runner with Jev's risk judgment scripted to "medium" unless a test passes its own. */
function plan(options: Parameters<typeof runProjectPlannerExample>[0]) {
  return runProjectPlannerExample({
    judge: createMockJudge({ risk: "medium" }).model,
    ...options,
  });
}

test("critical path: each task starts when its last dependency finishes", () => {
  expect(criticalPath(slowPlan.tasks)).toEqual({
    schedule: [
      { id: "T1", start: 0, finish: 5 },
      { id: "T2", start: 5, finish: 15 },
      { id: "T3", start: 5, finish: 8 },
      { id: "T4", start: 15, finish: 25 },
    ],
    projectDays: 25,
  });
  expect(graphProblems(cyclicPlan.tasks)).toEqual(["the dependencies contain a cycle"]);
  expect(graphProblems([task("T1", 1), task("T1", 1, ["T9"])])).toEqual([
    'duplicate task id "T1"',
    'T1 depends on unknown task "T9"',
  ]);
});

test("on time: the first plan fits the deadline", async () => {
  const result = await plan({
    deadlineDays: 30,
    generateText: scripted({ generateTasks: [slowPlan] }).generateText,
  });

  expect(result).toMatchObject({
    outcome: "done",
    projectDays: 25,
    deadlineDays: 30,
    onTime: true,
    replans: 0,
  });
  expect(result.risk).toBe("medium");
  expect(result.summary.split("\n")).toEqual([
    'Plan for "Ship a mobile app MVP for iOS and Android": 25 day(s), deadline 30.',
    "T1 Task T1: day 0–5",
    "T2 Task T2: day 5–15",
    "T3 Task T3: day 5–8",
    "T4 Task T4: day 15–25",
    "Risk: medium. Mitigation: Parallelize testing.",
  ]);
  // Choice states (`checkingTasks`, `routingGraph`, `routingDeadline`) are
  // left in the same step they are entered, so they never show as a settled state.
  expect(result.progress).toEqual([
    "generatingTasks",
    "validatingGraph",
    "scheduling",
    "assessingRisk",
    "suggestingMitigation",
    "done",
  ]);
});

test("one replan shortens the plan to fit", async () => {
  const executors = scripted({ generateTasks: [slowPlan], replanTasks: [fastPlan] });
  const result = await plan({
    deadlineDays: 10,
    generateText: executors.generateText,
  });

  expect(result).toMatchObject({ outcome: "done", projectDays: 8, onTime: true, replans: 1 });
  expect(result.progress.filter((state) => state === "replanning")).toHaveLength(1);
  expect(result.progress.filter((state) => state === "scheduling")).toHaveLength(2);
  // The replanner sees the machine's computed schedule, not a model's dates.
  const replanInput = executors.calls.find((call) => call.name === "replanTasks")!.input as {
    projectDays: number;
    gantt: string[];
  };
  expect(replanInput.projectDays).toBe(25);
  expect(replanInput.gantt).toContain("T4 Task T4: day 15–25");
});

test("a cycle is sent back for regeneration, then scheduled", async () => {
  const executors = scripted({ generateTasks: [cyclicPlan], regenerateTasks: [fastPlan] });
  const result = await plan({ generateText: executors.generateText });

  expect(result).toMatchObject({ outcome: "done", projectDays: 8 });
  expect(result.progress.slice(0, 5)).toEqual([
    "generatingTasks",
    "validatingGraph",
    "regeneratingTasks",
    "validatingGraph",
    "scheduling",
  ]);
  const regenInput = executors.calls.find((call) => call.name === "regenerateTasks")!.input as {
    problems: string[];
  };
  expect(regenInput.problems).toEqual(["the dependencies contain a cycle"]);
});

test("an invalid graph after MAX_REGENERATIONS ends in failed", async () => {
  const executors = scripted({ generateTasks: [cyclicPlan], regenerateTasks: [cyclicPlan] });
  const result = await plan({ generateText: executors.generateText });

  expect(result).toMatchObject({ outcome: "failed", onTime: false, projectDays: null });
  expect(result.summary).toContain(`still invalid after ${MAX_REGENERATIONS} regeneration(s)`);
  expect(executors.calls.filter((call) => call.name === "regenerateTasks")).toHaveLength(
    MAX_REGENERATIONS,
  );
  expect(result.progress).not.toContain("scheduling");
});

test("each replan gets its own repair budget", async () => {
  // The first plan spends every repair before it schedules (25 days, deadline
  // 10). The replan then has a bad dependency: it must still be repairable.
  const typoPlan = { tasks: [task("T1", 3), task("T2", 5, ["T9"])] };
  const executors = scripted({
    generateTasks: [cyclicPlan],
    regenerateTasks: [cyclicPlan, slowPlan, fastPlan],
    replanTasks: [typoPlan],
  });
  const result = await plan({ deadlineDays: 10, generateText: executors.generateText });

  expect(result).toMatchObject({ outcome: "done", projectDays: 8, onTime: true, replans: 1 });
  expect(executors.calls.filter((call) => call.name === "regenerateTasks")).toHaveLength(
    MAX_REGENERATIONS + 1,
  );
});

test("replan budget exhausted: failed with the best schedule found", async () => {
  const mediumPlan = { tasks: [task("T1", 5), task("T2", 7, ["T1"])] };
  const executors = scripted({ generateTasks: [slowPlan], replanTasks: [mediumPlan, slowPlan] });
  const result = await plan({
    deadlineDays: 5,
    generateText: executors.generateText,
  });

  expect(result).toMatchObject({
    outcome: "failed",
    onTime: false,
    replans: MAX_REPLANS,
    projectDays: 12,
  });
  expect(result.summary).toContain(
    `Cannot meet the 5-day deadline: the best plan after ${MAX_REPLANS} replan(s) takes 12 days.`,
  );
  expect(result.summary).toContain("T2 Task T2: day 5–12");
  expect(result.progress.filter((state) => state === "replanning")).toHaveLength(MAX_REPLANS);
});

test("tasks are capped at MAX_TASKS; zero tasks or a model error is failed", async () => {
  const many = { tasks: Array.from({ length: MAX_TASKS + 3 }, (_, i) => task(`T${i + 1}`, 1)) };
  const executors = scripted({ generateTasks: [many] });
  const capped = await plan({ generateText: executors.generateText });
  expect(capped.summary.split("\n").filter((line) => line.includes(": day "))).toHaveLength(
    MAX_TASKS,
  );

  const empty = await plan({
    generateText: scripted({ generateTasks: [{ tasks: [] }] }).generateText,
  });
  expect(empty).toMatchObject({ outcome: "failed" });
  expect(empty.summary).toContain("no tasks");

  const broken = await plan({
    generateText: scripted({
      generateTasks: [
        () => {
          throw new Error("provider down");
        },
      ],
    }).generateText,
  });
  expect(broken.outcome).toBe("failed");
  expect(broken.summary).toContain("generateTasks failed");
});

test("starters behave as their labels advertise", async () => {
  const starters = JSON.parse(readFileSync(new URL("./metadata.json", import.meta.url), "utf8"))
    .starters as Array<{ label: string; input: { goal: string; deadlineDays: number } }>;
  // The same 25-day first plan for every starter; the deadline decides the branch.
  for (const starter of starters) {
    const result = await plan({
      ...starter.input,
      generateText: scripted({ generateTasks: [slowPlan], replanTasks: [fastPlan] }).generateText,
    });
    if (starter.label.includes("triggers a replan")) {
      expect(result.progress).toContain("replanning");
    } else {
      expect(starter.label).toContain("fits on the first plan");
      expect(result.progress).not.toContain("replanning");
      expect(result.onTime).toBe(true);
    }
  }
});

test("the first plan is an honest estimate: the planner is never told the deadline", async () => {
  // Told the date, the model fits its first plan to it and the replan branch
  // never runs (QA: the "tight deadline" starter came back with Replans: 0).
  // The deadline enters only through the machine's check and the replanner.
  const executors = scripted({ generateTasks: [slowPlan], replanTasks: [fastPlan] });
  const result = await plan({
    goal: "Ship a mobile app MVP for iOS and Android",
    deadlineDays: 10,
    generateText: executors.generateText,
  });

  const first = executors.calls.find((call) => call.name === "generateTasks")!;
  expect(first.input).toEqual({ goal: "Ship a mobile app MVP for iOS and Android" });
  expect(`${first.request.system}\n${first.request.prompt}`).not.toMatch(/deadline|\b10\b/i);
  const replan = executors.calls.find((call) => call.name === "replanTasks")!;
  expect(String(replan.request.prompt)).toContain("deadline is 10");
  expect(result.replans).toBe(1);
});

test("assessingRisk asks Jev one choice over the computed schedule; the deadline, not the label, routes", async () => {
  const jev = createMockJudge({ risk: "high" });
  const executors = scripted({ generateTasks: [slowPlan] });
  const result = await plan({
    deadlineDays: 30,
    generateText: executors.generateText,
    judge: jev.model,
  });

  expect(jev.calls).toHaveLength(1);
  const call = jev.calls[0]!;
  expect(call.state).toEqual({
    goal: "Ship a mobile app MVP for iOS and Android",
    schedule: [
      "T1 Task T1: day 0–5",
      "T2 Task T2: day 5–15",
      "T3 Task T3: day 5–8",
      "T4 Task T4: day 15–25",
    ],
    projectDays: 25,
    deadlineDays: 30,
  });
  expect(Object.keys(call.questions)).toEqual(["risk"]);
  const question = call.questions.risk!;
  expect(question.type).toBe("choice");
  expect(question.type === "choice" && Object.keys(question.criteria)).toEqual([
    "low",
    "medium",
    "high",
  ]);
  // The judged label reaches the output and the mitigation request...
  expect(result.risk).toBe("high");
  const mitigationInput = executors.calls.find((c) => c.name === "suggestMitigation")!.input as {
    risk: string;
  };
  expect(mitigationInput.risk).toBe("high");
  // ...but a "high" plan that fits the deadline is still done, with no replan.
  expect(result).toMatchObject({ outcome: "done", onTime: true, replans: 0 });
});

test("lintAgentMachine is clean", () => {
  expect(() => lintAgentMachine(projectPlannerMachine, { throw: true })).not.toThrow();
});
