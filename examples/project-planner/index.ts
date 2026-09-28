/**
 * Project planner — the "project manager assistant" agent (a community
 * LangGraph tutorial) where the model proposes tasks and the MACHINE computes
 * the schedule.
 *
 * The idea: from a goal, the model breaks the project into tasks with
 * durations and dependencies. Those are scheduled, a risk assessment follows,
 * and when the plan is too risky the agent goes back and re-plans. Here "too
 * risky" is a fact the machine checks — the computed project length against
 * the deadline — and the dates are never a model's arithmetic.
 *
 * LangGraph shape (NirDiamant/GenAI_Agents, project_manager_assistant_agent):
 *
 *   START → task_generation → task_dependencies → task_scheduler → task_allocator
 *         → risk_assessment ─┬─ (risk too high, iterations < max) → task_scheduler …
 *                            └─ END
 *
 * Machine shape:
 *
 *   generatingTasks → checkingTasks ─┬─ failed (no tasks)
 *                                    └─ validatingGraph → routingGraph ─┬─ scheduling
 *                                                                       ├─ regeneratingTasks → checkingTasks
 *                                                                       └─ failed (MAX_REGENERATIONS)
 *   scheduling → assessingRisk → suggestingMitigation → routingDeadline ─┬─ done (projectDays <= deadlineDays)
 *                                                                        ├─ replanning → checkingTasks (replans < MAX_REPLANS)
 *                                                                        └─ failed (best schedule + "cannot meet the deadline")
 *
 * What maps to what:
 *   - task_generation + task_dependencies → `generatingTasks` (request
 *     `generateTasks`: tasks with `days` and `dependsOn` in one call)
 *   - (no LangGraph node)  → `validatingGraph` (actor: unique ids, known
 *     dependencies, acyclic) + `routingGraph` (choice) + `regeneratingTasks`
 *   - task_scheduler       → `scheduling` (actor `computeSchedule`: critical path)
 *   - risk_assessment      → `assessingRisk` (Jev judgment `assessRisk`: a
 *                            `choice` of low/medium/high — see note below)
 *                            + `suggestingMitigation` (request `suggestMitigation`)
 *   - the risk loop edge   → `routingDeadline` (choice on projectDays vs deadlineDays)
 *   - re-plan              → `replanning` (request `replanTasks`, same task shape)
 *
 * Differences from LangGraph worth calling out:
 *   - The model never computes dates. LangGraph asks the LLM to schedule the
 *     tasks; here `computeSchedule` is a pure earliest-start / critical-path
 *     pass, so the project length is correct by construction.
 *   - The dependency graph is checked before anything is scheduled. A
 *     duplicate id, an unknown dependency, or a cycle sends the tasks back to
 *     the model with the problems listed, at most MAX_REGENERATIONS times per
 *     proposed plan (a replan starts a fresh repair budget).
 *   - Risk is a JUDGMENT, the mitigation a generation. LangGraph asks one LLM
 *     for both. Here `assessingRisk` asks the AI SDK's `experimental_evaluate`
 *     with Jev (`@ai-sdk/typesafe-ai`) as the evaluation model one
 *     `choice` over `{ goal, schedule, projectDays, deadlineDays }` (the
 *     computed schedule, not the model's), and only the mitigation, free text
 *     the output and the replanner both read, stays a text-model request.
 *   - The loop exit is the deadline, not the risk label. `risk` and
 *     `mitigation` are advisory and reported in the output;
 *     `routingDeadline` re-plans only when the computed length misses the
 *     deadline, at most MAX_REPLANS times, then ends in `failed` with the best
 *     (shortest) schedule found.
 *   - Team allocation (task_allocator) is left out: there is no team roster.
 *
 * Stand-ins: none. `validateGraph` and `computeSchedule` are real, pure
 * functions over the model's proposed tasks.
 *
 * Dual-mode: `runProjectPlannerExample(options?)` takes an injectable
 * `generateText` (tests pass a scripted mock, CI needs no API key); the
 * direct run uses real models.
 *
 * Run: OPENAI_API_KEY=... TYPESAFE_AI_API_KEY=... npx tsx examples/project-planner/index.ts
 */
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { createAsyncLogic } from "xstate";
import { experimental_evaluate as evaluate, type Experimental_EvaluationModel } from "ai";
import { typeSafeAi } from "@ai-sdk/typesafe-ai";
import { createAiSdkExecutors } from "@statelyai/agent/ai-sdk";
import {
  getStatePath,
  createAgentRuntime,
  runToQuiescence,
  setupAgent,
  type AgentRequestExecutors,
} from "@statelyai/agent";

const models = {
  planner: openai("gpt-5.4-mini"),
};

/**
 * The judge: TypeSafe's Jev through the AI SDK's evaluation-model provider.
 * Reads `TYPESAFE_AI_API_KEY`. Tests pass a mock evaluation model instead.
 */
const judgeModel: Experimental_EvaluationModel = typeSafeAi.evaluationModel("jev-latest");

/** Most tasks a plan may hold, whatever the model returns. */
export const MAX_TASKS = 8;
/** Times an invalid task graph is sent back to the model before `failed`. */
export const MAX_REGENERATIONS = 2;
/** Times a plan that misses the deadline is re-planned before `failed`. */
export const MAX_REPLANS = 2;
export const DEFAULT_DEADLINE_DAYS = 30;

const taskSchema = z.object({
  id: z.string(),
  name: z.string(),
  days: z.number().int().min(1).max(20),
  dependsOn: z.array(z.string()),
});

export type PlannedTask = z.infer<typeof taskSchema>;

const scheduleEntrySchema = z.object({ id: z.string(), start: z.number(), finish: z.number() });

type ScheduleEntry = z.infer<typeof scheduleEntrySchema>;

const riskSchema = z.enum(["low", "medium", "high"]);

/**
 * risk_assessment as a judgment: the computed schedule and the deadline are
 * the state, and one `choice` names the delivery risk. The judge model is
 * injected by tests and hosts; the default is Jev.
 */
export function createAssessRisk(model: Experimental_EvaluationModel = judgeModel) {
  return createAsyncLogic<
    { answers: { risk: { choice: "low" | "medium" | "high" } } },
    { goal: string; schedule: string[]; projectDays: number; deadlineDays: number }
  >({
    run: async ({ input, signal }) => {
      const { answers } = await evaluate({
        model,
        state: {
          goal: input.goal,
          schedule: input.schedule,
          projectDays: input.projectDays,
          deadlineDays: input.deadlineDays,
        },
        questions: {
          risk: {
            type: "choice" as const,
            instructions:
              "How likely is the project in `goal` to miss `deadlineDays`, given the computed " +
              "`schedule` (one line per task, in days) that finishes on day `projectDays`?",
            criteria: {
              low: "The schedule finishes well inside the deadline, with slack to absorb a slipped task.",
              medium:
                "The schedule fits the deadline with little slack, or one long task or dependency " +
                "chain would push it over if it slipped.",
              high: "The schedule misses the deadline, or finishes so close to it that any slip on the critical path misses it.",
            },
          },
        },
        abortSignal: signal,
      });
      return { answers };
    },
  });
}

/** Kahn's algorithm: the tasks in dependency order, or null if there is a cycle. */
function topologicalOrder(tasks: PlannedTask[]): PlannedTask[] | null {
  const remaining = new Map(tasks.map((task) => [task.id, new Set(task.dependsOn)]));
  const order: PlannedTask[] = [];
  let ready = tasks.filter((task) => task.dependsOn.length === 0);
  while (ready.length > 0) {
    order.push(...ready);
    for (const done of ready) remaining.delete(done.id);
    for (const deps of remaining.values()) for (const done of ready) deps.delete(done.id);
    ready = tasks.filter((task) => remaining.get(task.id)?.size === 0);
  }
  return order.length === tasks.length ? order : null;
}

/** Every structural problem with the proposed task graph; empty means valid. */
export function graphProblems(tasks: PlannedTask[]): string[] {
  const ids = tasks.map((task) => task.id);
  const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
  const unknown = tasks.flatMap((task) =>
    task.dependsOn
      .filter((dep) => !ids.includes(dep))
      .map((dep) => `${task.id} depends on unknown task "${dep}"`),
  );
  const problems = [...duplicates.map((id) => `duplicate task id "${id}"`), ...unknown];
  // Only look for a cycle in a graph whose ids and references are sound.
  return problems.length === 0 && topologicalOrder(tasks) === null
    ? ["the dependencies contain a cycle"]
    : problems;
}

/** Earliest-start schedule: each task starts when its last dependency finishes. */
export function criticalPath(tasks: PlannedTask[]) {
  const finish = new Map<string, number>();
  const schedule: ScheduleEntry[] = [];
  for (const task of topologicalOrder(tasks) ?? []) {
    const start = Math.max(0, ...task.dependsOn.map((dep) => finish.get(dep) ?? 0));
    finish.set(task.id, start + task.days);
    schedule.push({ id: task.id, start, finish: start + task.days });
  }
  return { schedule, projectDays: Math.max(0, ...schedule.map((entry) => entry.finish)) };
}

/** Gantt-ish lines: "T1 Name: day 0–5". */
function renderGantt(tasks: PlannedTask[], schedule: ScheduleEntry[]): string[] {
  return schedule.map((entry) => {
    const name = tasks.find((task) => task.id === entry.id)?.name ?? "";
    return `${entry.id} ${name}: day ${entry.start}–${entry.finish}`;
  });
}

const plannerContextSchema = z.object({
  goal: z.string(),
  deadlineDays: z.number(),
  tasks: z.array(taskSchema),
  /** Problems the validator found in the last task graph (fed back on regeneration). */
  problems: z.array(z.string()),
  regenerations: z.number(),
  replans: z.number(),
  schedule: z.array(scheduleEntrySchema),
  projectDays: z.number().nullable(),
  /** Shortest valid plan seen so far: the best-effort output of `failed`. */
  best: z
    .object({
      tasks: z.array(taskSchema),
      schedule: z.array(scheduleEntrySchema),
      projectDays: z.number(),
    })
    .nullable(),
  risk: riskSchema.nullable(),
  mitigation: z.string().nullable(),
  failure: z.string().nullable(),
});

type PlannerContext = z.infer<typeof plannerContextSchema>;

const tasksOutputSchema = z.object({ tasks: z.array(taskSchema) });

const TASK_RULES =
  `At most ${MAX_TASKS} tasks. Each task has a short unique id (T1, T2, …), a name, ` +
  "a duration in whole days (1-20), and dependsOn: the ids of tasks that must finish " +
  "first. Dependencies must refer to ids in the list and must not form a cycle. " +
  "Do not compute dates.";

const plannerOutputSchema = z.object({
  summary: z.string(),
  projectDays: z.number().nullable(),
  deadlineDays: z.number(),
  risk: riskSchema.nullable(),
  mitigation: z.string().nullable(),
  replans: z.number(),
  onTime: z.boolean(),
});

const agentSetup = setupAgent({
  models,
  context: plannerContextSchema,
  input: z.object({
    goal: z.string(),
    deadlineDays: z.number().int().positive().default(DEFAULT_DEADLINE_DAYS),
  }),
  output: plannerOutputSchema,
  actors: {
    // risk_assessment: a Jev judgment (see createAssessRisk).
    assessRisk: createAssessRisk(),
    validateGraph: createAsyncLogic<{ problems: string[] }, { tasks: PlannedTask[] }>({
      run: async ({ input }) => ({ problems: graphProblems(input.tasks) }),
    }),
    computeSchedule: createAsyncLogic<
      { schedule: ScheduleEntry[]; projectDays: number },
      { tasks: PlannedTask[] }
    >({
      run: async ({ input }) => criticalPath(input.tasks),
    }),
  },
  requests: {
    // task_generation + task_dependencies, in one structured call.
    generateTasks: {
      schemas: {
        input: z.object({ goal: z.string(), deadlineDays: z.number() }),
        output: tasksOutputSchema,
      },
      model: "planner",
      system: `You are a project manager. Break the goal into tasks. ${TASK_RULES}`,
      prompt: ({ input }) => `Goal: ${input.goal}\nDeadline: ${input.deadlineDays} days`,
    },
    // Repair an invalid graph, told exactly what is wrong with it.
    regenerateTasks: {
      schemas: {
        input: z.object({
          goal: z.string(),
          tasks: z.array(taskSchema),
          problems: z.array(z.string()),
        }),
        output: tasksOutputSchema,
      },
      model: "planner",
      system: `You are a project manager fixing an invalid task list. ${TASK_RULES}`,
      prompt: ({ input }) =>
        [
          `Goal: ${input.goal}`,
          `Tasks: ${JSON.stringify(input.tasks)}`,
          "Problems:",
          ...input.problems.map((problem) => `- ${problem}`),
        ].join("\n"),
    },
    // The mitigation for the judged risk: advisory, and read by the replanner.
    // The machine's loop exit is the deadline.
    suggestMitigation: {
      schemas: {
        input: z.object({
          goal: z.string(),
          gantt: z.array(z.string()),
          projectDays: z.number(),
          deadlineDays: z.number(),
          risk: riskSchema,
        }),
        output: z.object({ mitigation: z.string() }),
      },
      model: "planner",
      system:
        "Suggest one concrete mitigation for the delivery risk of a computed project " +
        "schedule against its deadline. One sentence.",
      prompt: ({ input }) =>
        [
          `Goal: ${input.goal}`,
          `Schedule (${input.projectDays} days, deadline ${input.deadlineDays} days, ` +
            `${input.risk} risk):`,
          ...input.gantt,
        ].join("\n"),
    },
    // Re-plan: shorten or parallelize to fit the deadline. Same task shape.
    replanTasks: {
      schemas: {
        input: z.object({
          goal: z.string(),
          tasks: z.array(taskSchema),
          gantt: z.array(z.string()),
          projectDays: z.number(),
          deadlineDays: z.number(),
          mitigation: z.string(),
        }),
        output: tasksOutputSchema,
      },
      model: "planner",
      system:
        "You are a project manager. The plan misses its deadline. Shorten it: remove " +
        "unnecessary dependencies so tasks run in parallel, split or trim long tasks. " +
        TASK_RULES,
      prompt: ({ input }) =>
        [
          `Goal: ${input.goal}`,
          `Current plan takes ${input.projectDays} days; deadline is ${input.deadlineDays}.`,
          ...input.gantt,
          `Tasks: ${JSON.stringify(input.tasks)}`,
          `Suggested mitigation: ${input.mitigation}`,
        ].join("\n"),
    },
  },
});

function plannerOutput(context: PlannerContext, onTime: boolean) {
  const plan = onTime
    ? { tasks: context.tasks, schedule: context.schedule, projectDays: context.projectDays }
    : context.best;
  const header = onTime
    ? `Plan for "${context.goal}": ${context.projectDays} day(s), deadline ${context.deadlineDays}.`
    : `${context.failure ?? "Planning failed."}`;
  return {
    summary: [
      header,
      ...(plan ? renderGantt(plan.tasks, plan.schedule) : []),
      ...(context.mitigation ? [`Risk: ${context.risk}. Mitigation: ${context.mitigation}`] : []),
    ].join("\n"),
    projectDays: plan?.projectDays ?? null,
    deadlineDays: context.deadlineDays,
    risk: context.risk,
    mitigation: context.mitigation,
    replans: context.replans,
    onTime,
  };
}

export const projectPlannerSchemas = agentSetup.schemas;

export const projectPlannerMachine = agentSetup.createMachine({
  id: "project-planner",
  context: ({ input }) => ({
    goal: input.goal,
    deadlineDays: input.deadlineDays,
    tasks: [],
    problems: [],
    regenerations: 0,
    replans: 0,
    schedule: [],
    projectDays: null,
    best: null,
    risk: null,
    mitigation: null,
    failure: null,
  }),
  initial: "generatingTasks",
  states: {
    generatingTasks: {
      invoke: {
        src: "generateTasks",
        input: ({ context }) => ({ goal: context.goal, deadlineDays: context.deadlineDays }),
        onDone: ({ output }) => ({
          target: "checkingTasks",
          context: { tasks: output.result.tasks.slice(0, MAX_TASKS) },
        }),
        onError: ({ event }) => ({
          target: "failed",
          context: { failure: `generateTasks failed: ${String(event.error)}` },
        }),
      },
    },
    // Every proposal (first, repaired, re-planned) comes through here.
    checkingTasks: {
      type: "choice",
      choice: ({ context }) =>
        context.tasks.length === 0
          ? { target: "failed", context: { failure: "The model proposed no tasks." } }
          : { target: "validatingGraph" },
    },
    validatingGraph: {
      invoke: {
        src: "validateGraph",
        input: ({ context }) => ({ tasks: context.tasks }),
        onDone: ({ output }) => ({
          target: "routingGraph",
          context: { problems: output.problems },
        }),
        onError: ({ event }) => ({
          target: "failed",
          context: { failure: `validateGraph failed: ${String(event.error)}` },
        }),
      },
    },
    routingGraph: {
      type: "choice",
      choice: ({ context }) => {
        if (context.problems.length === 0) return { target: "scheduling" };
        if (context.regenerations < MAX_REGENERATIONS) {
          return {
            target: "regeneratingTasks",
            context: { regenerations: context.regenerations + 1 },
          };
        }
        return {
          target: "failed",
          context: {
            failure:
              `The task graph was still invalid after ${context.regenerations} ` +
              `regeneration(s): ${context.problems.join("; ")}.`,
          },
        };
      },
    },
    regeneratingTasks: {
      invoke: {
        src: "regenerateTasks",
        input: ({ context }) => ({
          goal: context.goal,
          tasks: context.tasks,
          problems: context.problems,
        }),
        onDone: ({ output }) => ({
          target: "checkingTasks",
          context: { tasks: output.result.tasks.slice(0, MAX_TASKS) },
        }),
        onError: ({ event }) => ({
          target: "failed",
          context: { failure: `regenerateTasks failed: ${String(event.error)}` },
        }),
      },
    },
    // The machine is the ground truth for dates.
    scheduling: {
      invoke: {
        src: "computeSchedule",
        input: ({ context }) => ({ tasks: context.tasks }),
        onDone: ({ context, output }) => ({
          target: "assessingRisk",
          context: {
            schedule: output.schedule,
            projectDays: output.projectDays,
            best:
              context.best && context.best.projectDays <= output.projectDays
                ? context.best
                : { tasks: context.tasks, ...output },
          },
        }),
        onError: ({ event }) => ({
          target: "failed",
          context: { failure: `computeSchedule failed: ${String(event.error)}` },
        }),
      },
    },
    assessingRisk: {
      invoke: {
        src: "assessRisk",
        input: ({ context }) => ({
          goal: context.goal,
          schedule: renderGantt(context.tasks, context.schedule),
          projectDays: context.projectDays ?? 0,
          deadlineDays: context.deadlineDays,
        }),
        onDone: ({ output }) => ({
          target: "suggestingMitigation",
          context: { risk: output.answers.risk.choice },
        }),
        onError: ({ event }) => ({
          target: "failed",
          context: { failure: `assessRisk failed: ${String(event.error)}` },
        }),
      },
    },
    suggestingMitigation: {
      invoke: {
        src: "suggestMitigation",
        input: ({ context }) => ({
          goal: context.goal,
          gantt: renderGantt(context.tasks, context.schedule),
          projectDays: context.projectDays ?? 0,
          deadlineDays: context.deadlineDays,
          risk: context.risk ?? "high",
        }),
        onDone: ({ output }) => ({
          target: "routingDeadline",
          context: { mitigation: output.result.mitigation },
        }),
        onError: ({ event }) => ({
          target: "failed",
          context: { failure: `suggestMitigation failed: ${String(event.error)}` },
        }),
      },
    },
    // The loop exit: the computed length against the deadline, not the risk label.
    routingDeadline: {
      type: "choice",
      choice: ({ context }) => {
        if ((context.projectDays ?? Infinity) <= context.deadlineDays) return { target: "done" };
        if (context.replans < MAX_REPLANS) {
          return { target: "replanning", context: { replans: context.replans + 1 } };
        }
        return {
          target: "failed",
          context: {
            failure:
              `Cannot meet the ${context.deadlineDays}-day deadline: the best plan after ` +
              `${context.replans} replan(s) takes ${context.best?.projectDays} days.`,
          },
        };
      },
    },
    replanning: {
      invoke: {
        src: "replanTasks",
        input: ({ context }) => ({
          goal: context.goal,
          tasks: context.tasks,
          gantt: renderGantt(context.tasks, context.schedule),
          projectDays: context.projectDays ?? 0,
          deadlineDays: context.deadlineDays,
          mitigation: context.mitigation ?? "",
        }),
        // A replan is a new proposed graph, so it gets its own repair budget;
        // MAX_REPLANS still bounds how many graphs are proposed in total.
        onDone: ({ output }) => ({
          target: "checkingTasks",
          context: { tasks: output.result.tasks.slice(0, MAX_TASKS), regenerations: 0 },
        }),
        onError: ({ event }) => ({
          target: "failed",
          context: { failure: `replanTasks failed: ${String(event.error)}` },
        }),
      },
    },
    done: {
      type: "final",
      output: ({ context }) => plannerOutput(context, true),
    },
    // Invalid graph, missed deadline, or a failed call: the best valid
    // schedule found (if any) is the best-effort output.
    failed: {
      type: "final",
      output: ({ context }) => plannerOutput(context, false),
    },
  },
});

export interface RunProjectPlannerOptions {
  goal?: string;
  deadlineDays?: number;
  /** Injected for tests; the direct run supplies a real model executor. */
  generateText?: AgentRequestExecutors["generateText"];
  /** The judge model; tests pass a mock, the direct run uses Jev. */
  judge?: Experimental_EvaluationModel;
  /** Observes each machine transition. */
  onProgress?: (state: string) => void;
}

export type ProjectPlannerResult = z.infer<typeof plannerOutputSchema> & {
  /** The final state reached: `done` or `failed`. */
  outcome: string;
  progress: string[];
};

/** Runs the planner; records state progress so regenerations and replans are observable. */
export async function runProjectPlannerExample(
  options: RunProjectPlannerOptions = {},
): Promise<ProjectPlannerResult> {
  const {
    goal = "Ship a mobile app MVP for iOS and Android",
    deadlineDays = DEFAULT_DEADLINE_DAYS,
    generateText,
    judge,
    onProgress,
  } = options;
  const progress: string[] = [];
  const result = await runToQuiescence(
    createAgentRuntime(projectPlannerMachine, {
      executors: generateText ? { generateText } : createAiSdkExecutors({ models }),
      ...(judge ? { actors: { assessRisk: createAssessRisk(judge) } } : {}),
      onTransition: (snapshot) => {
        const state = getStatePath(snapshot);
        progress.push(state);
        onProgress?.(state);
      },
    }),
    {
      input: { goal, deadlineDays },
    },
  );
  if (result.status !== "done") {
    throw new Error(`Project-planner example did not complete: ${result.status}`);
  }
  return { ...result.output, outcome: getStatePath(result.snapshot), progress };
}

// Run directly (`tsx index.ts`); skipped when a test imports this module.
if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  if (!process.env.OPENAI_API_KEY || !process.env.TYPESAFE_AI_API_KEY) {
    console.error("Set OPENAI_API_KEY and TYPESAFE_AI_API_KEY to run this example.");
    process.exit(1);
  }
  void (async () => {
    const result = await runProjectPlannerExample({
      deadlineDays: 21,
      onProgress: (state) => console.log(`  → ${state}`),
    });
    console.log(`\n[${result.outcome}]\n`);
    console.log(result.summary);
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
