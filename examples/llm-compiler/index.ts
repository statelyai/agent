/**
 * LLMCompiler — LangGraph's "LLMCompiler" tutorial (Kim et al. 2023) as a
 * machine whose task-fetching unit is real, visible fan-out.
 *
 * The idea: instead of a ReAct loop that calls one tool per model turn, a
 * planner emits a whole DAG of tool calls up front. Tasks name their
 * dependencies (`$1`, `$2` in their arguments stand for earlier results), and a
 * scheduler runs every task whose dependencies have resolved, in parallel. A
 * joiner then reads the observations and either answers or asks for a new plan
 * with feedback.
 *
 * LangGraph shape (tutorials/llm-compiler/LLMCompiler):
 *
 *   START → plan_and_schedule ──→ join ──┬─ END            (FinalResponse)
 *             ▲                          │
 *             └──────────────────────────┘                  (Replan + feedback,
 *                                                            until recursion_limit)
 *
 * `plan_and_schedule` streams the planner's tasks into a thread pool that
 * starts each task once its `$N` inputs exist. Here the scheduler is states:
 *
 *   planning → validatingPlan ─┬─ dispatching ⇄ collecting → joining → routingJoin ─┬─ done
 *      ▲                       │  (spawn one wave) (land results)                    ├─ planning
 *      └───────────────────────┴─ planning (invalid plan, counts as a replan)        └─ failed
 *                              └─ failed   (replan budget spent)
 *
 * What maps to what:
 *   - planner                → `planning` (a structured request: a list of
 *                              `{ tool, args }` tasks). As in LLMCompiler, a
 *                              task's id is its 1-based position, and its
 *                              dependencies are the `$N` references in its
 *                              args — parsed, not declared
 *   - (implicit) plan parse  → `validatingPlan`, a choice state: the plan is
 *                              non-empty, at most `MAX_TASKS` long, and every
 *                              `$N` names an EARLIER position
 *   - task fetching unit     → `dispatching` + `collecting`: `dispatching`
 *                              spawns every task whose dependencies have
 *                              landed as one `runTool` child (one "wave");
 *                              `collecting` lands each child's
 *                              `xstate.done.actor` / `xstate.error.actor` and
 *                              goes back to `dispatching` as soon as a new
 *                              task is unblocked
 *   - `$N` substitution      → done at spawn time from landed results, so a
 *                              dependent task literally cannot start early
 *   - joiner                 → `joining` (structured `{ action, answer, feedback }`)
 *   - should_continue        → `routingJoin`, a choice state
 *   - recursion_limit        → `MAX_REPLANS`, a counter in context
 *
 * Differences from LangGraph worth calling out:
 *   - The plan is validated by the machine, not trusted. A `$5` that no
 *     earlier task produces (a forward or self reference) would stall a
 *     scheduler waiting on it; here an invalid plan is a transition back to
 *     `planning` with the problem as feedback, and it spends the same replan
 *     budget as a joiner replan.
 *   - Waves are recorded. Every spawned task carries the wave it started in
 *     (`schedule[].wave`), so "these two searches ran at the same time and
 *     the math waited for both" is data you can assert on, not a log line.
 *   - A tool error is an observation (`[tool error] …`), as in the paper: the
 *     joiner sees it and can replan. It does not abort the run.
 *   - Streaming the planner into the scheduler (tasks start while the plan is
 *     still being generated) is not modeled: the plan arrives whole, then
 *     executes.
 *   - The joiner's "replan" is bounded by `MAX_REPLANS` in a choice state;
 *     exhausting it lands in `failed`, never in `done` with an empty answer.
 *
 * Stand-ins (NO network):
 *   - `search` is a keyword lookup over `SAMPLE_FACTS`, a tiny in-file table
 *     of illustrative figures. Results are prefixed `[sample search]`.
 *   - `math` is a hand-written recursive-descent evaluator over numbers,
 *     `+ - * /` and parentheses. No `eval`, no `Function`.
 *   - `finish` echoes its (substituted) argument: the plan's closing step.
 *
 * Dual-mode: `runLlmCompilerExample(options?)` takes an injectable
 * `generateText` (tests pass scripted answers; no API key); the direct run
 * uses real models.
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/llm-compiler/index.ts
 */
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { createAsyncLogic } from "xstate";
import { createAiSdkExecutors } from "@statelyai/agent/ai-sdk";
import {
  getStatePath,
  createAgentRuntime,
  runToQuiescence,
  setupAgent,
  type AgentRequestExecutors,
  type DoneActorEventOf,
} from "@statelyai/agent";

const models = {
  compiler: openai("gpt-5.4-mini"),
};

/** Replans allowed after the first plan (invalid plans and joiner replans both count). */
export const MAX_REPLANS = 2;

/** Largest plan the planner may return. */
export const MAX_TASKS = 6;

/**
 * Sample data: the facts `search` can find. Illustrative round figures, NOT
 * live data — a stand-in for a search API with the same machine shape.
 */
export const SAMPLE_FACTS: Array<{
  subject: string;
  metric: "population" | "gdp";
  value: number;
  unit: string;
}> = [
  { subject: "France", metric: "population", value: 68.4, unit: "million people" },
  { subject: "Germany", metric: "population", value: 84.5, unit: "million people" },
  { subject: "Japan", metric: "population", value: 124.5, unit: "million people" },
  { subject: "Tokyo", metric: "population", value: 14.1, unit: "million people" },
  { subject: "Paris", metric: "population", value: 2.1, unit: "million people" },
  { subject: "Berlin", metric: "population", value: 3.9, unit: "million people" },
  { subject: "France", metric: "gdp", value: 3.1, unit: "trillion USD" },
  { subject: "Germany", metric: "gdp", value: 4.5, unit: "trillion USD" },
  { subject: "Japan", metric: "gdp", value: 4.2, unit: "trillion USD" },
];

const METRIC_WORDS: Record<"population" | "gdp", string[]> = {
  population: ["population", "people", "inhabitants", "residents"],
  gdp: ["gdp", "economy", "economic output"],
};

/** A tool call's result: the labeled observation and the bare value `$N` stands for. */
const toolResultSchema = z.object({ observation: z.string(), value: z.string() });
type ToolResult = z.infer<typeof toolResultSchema>;

/** `search`: every sample fact whose subject and metric the query names. */
function searchFacts(query: string): ToolResult {
  const text = query.toLowerCase();
  const hits = SAMPLE_FACTS.filter(
    (fact) =>
      text.includes(fact.subject.toLowerCase()) &&
      METRIC_WORDS[fact.metric].some((word) => text.includes(word)),
  );
  if (hits.length === 0) {
    return {
      observation: `[sample search] No sample fact matches "${query}".`,
      value: "unknown",
    };
  }
  return {
    observation: hits
      .map(
        (fact) =>
          `[sample search] ${fact.subject} ${fact.metric === "gdp" ? "GDP" : "population"}: ` +
          `${fact.value} ${fact.unit} (illustrative figure)`,
      )
      .join("; "),
    value: String(hits[0]!.value),
  };
}

/**
 * `math`: a safe arithmetic evaluator — numbers, `+ - * /`, parentheses and
 * unary minus, by recursive descent. Throws on anything else. No `eval`.
 */
export function evaluateArithmetic(expression: string): number {
  const tokens = expression.match(/\d+(?:\.\d+)?|[-+*/()]|\S/g) ?? [];
  let position = 0;
  const peek = () => tokens[position];
  const take = () => tokens[position++];

  function parseExpression(): number {
    let value = parseTerm();
    while (peek() === "+" || peek() === "-") {
      value = take() === "+" ? value + parseTerm() : value - parseTerm();
    }
    return value;
  }
  function parseTerm(): number {
    let value = parseFactor();
    while (peek() === "*" || peek() === "/") {
      const operator = take();
      const right = parseFactor();
      if (operator === "/" && right === 0) throw new Error("division by zero");
      value = operator === "*" ? value * right : value / right;
    }
    return value;
  }
  function parseFactor(): number {
    const token = take();
    if (token === "-") return -parseFactor();
    if (token === "(") {
      const value = parseExpression();
      if (take() !== ")") throw new Error("missing closing parenthesis");
      return value;
    }
    if (token !== undefined && /^\d/.test(token)) return Number(token);
    throw new Error(`unexpected ${token === undefined ? "end of input" : `"${token}"`}`);
  }

  const value = parseExpression();
  if (position !== tokens.length) throw new Error(`unexpected "${tokens[position]}"`);
  return value;
}

/** Rounds to 4 decimal places so observations stay readable. */
function formatNumber(value: number): string {
  return String(Math.round(value * 10_000) / 10_000);
}

/**
 * One scheduled tool call. A plain actor, spawned once per task; the machine
 * never waits on it by name, it lands via `xstate.done.actor`.
 */
export const runTool = createAsyncLogic<ToolResult, { tool: Tool; args: string }>({
  run: async ({ input }) => {
    if (input.tool === "search") return searchFacts(input.args);
    if (input.tool === "math") {
      const value = formatNumber(evaluateArithmetic(input.args));
      return { observation: `[math] ${input.args} = ${value}`, value };
    }
    return { observation: `[finish] ${input.args}`, value: input.args };
  },
});

const toolSchema = z.enum(["search", "math", "finish"]);
type Tool = z.infer<typeof toolSchema>;

// A task's id is its 1-based position in the plan, and its dependencies are
// the `$N` references in its args — both as in LLMCompiler.
const taskSchema = z.object({
  tool: toolSchema,
  args: z.string(),
});
type Task = z.infer<typeof taskSchema>;

// No min/max here: an empty or oversized plan is a replan (see
// `validatingPlan`), not a parse error that would end the run.
const planSchema = z.object({ tasks: z.array(taskSchema) });

const joinSchema = z.object({
  action: z.enum(["finish", "replan"]),
  answer: z.string().nullable(),
  feedback: z.string().nullable(),
});

const scheduledSchema = z.object({
  plan: z.number(),
  taskId: z.number(),
  wave: z.number(),
  tool: toolSchema,
  /** The args after `$N` substitution — what the tool actually ran on. */
  args: z.string(),
  /** `null` while the task is still running. */
  result: toolResultSchema.nullable(),
});
type Scheduled = z.infer<typeof scheduledSchema>;

const contextSchema = z.object({
  question: z.string(),
  /** Planner calls made (1-based plan number of the current plan). */
  plans: z.number(),
  /** Replans spent: invalid plans and joiner "replan" verdicts. */
  replans: z.number(),
  feedback: z.string().nullable(),
  /** The current plan. */
  tasks: z.array(taskSchema),
  /** Global wave counter: one wave per `dispatching` entry. */
  wave: z.number(),
  /** Every task ever spawned, with the wave it started in and its result. */
  schedule: z.array(scheduledSchema),
  /** Why each earlier plan was abandoned, for the trail. */
  abandoned: z.array(z.object({ plan: z.number(), reason: z.string() })),
  verdict: joinSchema.nullable(),
  answer: z.string().nullable(),
  failure: z.string().nullable(),
});
type CompilerContext = z.infer<typeof contextSchema>;

const PLACEHOLDER = /\$\{?(\d+)\}?/g;

/** A task's dependencies: the distinct `$N` references in its args. */
export function dependenciesOf(task: Task): number[] {
  return [...new Set([...task.args.matchAll(PLACEHOLDER)].map((match) => Number(match[1])))];
}

/** What is wrong with a plan, or `null` when it is a valid DAG. */
export function planProblem(tasks: Task[]): string | null {
  if (tasks.length === 0) return "the plan is empty";
  if (tasks.length > MAX_TASKS) {
    return `the plan has ${tasks.length} tasks; at most ${MAX_TASKS} are allowed`;
  }
  for (const [index, task] of tasks.entries()) {
    const position = index + 1;
    const bad = dependenciesOf(task).find((id) => id < 1 || id >= position);
    if (bad !== undefined) {
      return `task ${position} references $${bad}, which is not an earlier task`;
    }
  }
  return null;
}

/** The current plan's scheduled entries. */
function currentSchedule(context: CompilerContext): Scheduled[] {
  return context.schedule.filter((entry) => entry.plan === context.plans);
}

/**
 * Tasks of the current plan (with their positional ids) not yet spawned
 * whose `$N` dependencies have all landed.
 */
function readyTasks(context: CompilerContext): Array<Task & { id: number }> {
  const scheduled = currentSchedule(context);
  const landed = new Set(
    scheduled.filter((entry) => entry.result !== null).map((entry) => entry.taskId),
  );
  const started = new Set(scheduled.map((entry) => entry.taskId));
  return context.tasks
    .map((task, index) => ({ ...task, id: index + 1 }))
    .filter((task) => !started.has(task.id) && dependenciesOf(task).every((id) => landed.has(id)));
}

function allLanded(context: CompilerContext): boolean {
  const scheduled = currentSchedule(context);
  return (
    scheduled.length === context.tasks.length && scheduled.every((entry) => entry.result !== null)
  );
}

/** Replaces `$N` with task N's landed value. */
function substitute(args: string, scheduled: Scheduled[]): string {
  return args.replace(PLACEHOLDER, (match, id: string) => {
    const entry = scheduled.find((candidate) => candidate.taskId === Number(id));
    return entry?.result?.value ?? match;
  });
}

const TASK_PREFIX = "task-";

function taskActorId(plan: number, taskId: number): string {
  return `${TASK_PREFIX}${plan}-${taskId}`;
}

/** The schedule with the task behind `actorId` landed, or `null` if it is not a current task. */
function landResult(
  context: CompilerContext,
  actorId: string,
  result: ToolResult,
): Scheduled[] | null {
  const index = context.schedule.findIndex(
    (entry) =>
      entry.plan === context.plans &&
      entry.result === null &&
      taskActorId(entry.plan, entry.taskId) === actorId,
  );
  if (index === -1) return null;
  return context.schedule.map((entry, position) =>
    position === index ? { ...entry, result } : entry,
  );
}

/** Observations of the current plan, one line per task, for the joiner. */
function renderObservations(context: CompilerContext): string {
  return currentSchedule(context)
    .map((entry) => `$${entry.taskId} ${entry.tool}(${entry.args}) → ${entry.result?.observation}`)
    .join("\n");
}

/** Plans, waves and verdicts, one line each — rendered, never stored. */
function renderTrail(context: CompilerContext): string {
  const lines: string[] = [];
  for (let plan = 1; plan <= context.plans; plan++) {
    lines.push(`Plan ${plan}:`);
    const entries = context.schedule.filter((entry) => entry.plan === plan);
    if (entries.length === 0) lines.push("  (not executed)");
    for (const entry of entries) {
      lines.push(
        `  wave ${entry.wave}: $${entry.taskId} ${entry.tool}(${entry.args}) → ` +
          `${entry.result?.observation ?? "(still running)"}`,
      );
    }
    const abandoned = context.abandoned.find((entry) => entry.plan === plan);
    if (abandoned) lines.push(`  abandoned: ${abandoned.reason}`);
  }
  return lines.join("\n");
}

type ToolDoneEvent = DoneActorEventOf<typeof runTool>;

const agentSetup = setupAgent({
  models,
  context: contextSchema,
  input: z.object({ question: z.string() }),
  output: z.object({
    answer: z.string(),
    trail: z.string(),
    plans: z.number(),
    tasksRun: z.number(),
    waves: z.number(),
  }),
  actors: { runTool },
  requests: {
    // planner: the whole DAG in one structured call.
    plan: {
      schemas: {
        input: z.object({
          question: z.string(),
          feedback: z.string().nullable(),
          previous: z.string(),
        }),
        output: planSchema,
      },
      model: "compiler",
      system:
        "You are the planner of an LLMCompiler. Write a plan of tool calls that answers the " +
        "question. Tools: search(query) looks up one fact such as 'France population' or " +
        "'Japan GDP'; math(expression) evaluates arithmetic over numbers, + - * / and " +
        "parentheses; finish(answer) closes the plan. Tasks are numbered by position: the " +
        "first is 1, the second 2, and so on. Write $N in a task's args to use task N's " +
        "result; a task may only reference earlier tasks. Tasks that reference nothing run " +
        `in parallel, so keep independent lookups independent. At most ${MAX_TASKS} tasks.`,
      prompt: ({ input }) =>
        [
          `Question: ${input.question}`,
          input.feedback ? `\nFeedback on the previous attempt: ${input.feedback}` : "",
          input.previous ? `\nPrevious attempts:\n${input.previous}` : "",
        ].join(""),
    },
    // joiner: answer from the observations, or ask for a new plan.
    join: {
      schemas: {
        input: z.object({ question: z.string(), observations: z.string() }),
        output: joinSchema,
      },
      model: "compiler",
      system:
        "You are the joiner of an LLMCompiler. Read the tool observations. If they answer the " +
        "question, choose action 'finish' and write the answer. Otherwise choose 'replan' and " +
        "say in feedback what the next plan must do differently. Use only the observations.",
      prompt: ({ input }) => `Question: ${input.question}\n\nObservations:\n${input.observations}`,
    },
  },
});

export const llmCompilerSchemas = agentSetup.schemas;

export const llmCompilerMachine = agentSetup.createMachine({
  id: "llm-compiler",
  context: ({ input }) => ({
    question: input.question,
    plans: 0,
    replans: 0,
    feedback: null,
    tasks: [],
    wave: 0,
    schedule: [],
    abandoned: [],
    verdict: null,
    answer: null,
    failure: null,
  }),
  initial: "planning",
  states: {
    planning: {
      invoke: {
        src: "plan",
        input: ({ context }) => ({
          question: context.question,
          feedback: context.feedback,
          previous: context.plans > 0 ? renderTrail(context) : "",
        }),
        onDone: ({ context, output }) => ({
          target: "validatingPlan",
          context: { tasks: output.result.tasks, plans: context.plans + 1, verdict: null },
        }),
        onError: ({ event }) => ({
          target: "failed",
          context: { failure: `planner failed: ${String(event.error)}` },
        }),
      },
    },
    // The plan is a claim; the machine checks it is a DAG before running it.
    // An invalid plan spends a replan, exactly like a joiner "replan".
    validatingPlan: {
      type: "choice",
      choice: ({ context }) =>
        planProblem(context.tasks) === null
          ? { target: "dispatching" }
          : context.replans >= MAX_REPLANS
            ? {
                target: "failed",
                context: {
                  failure: `invalid plan after ${MAX_REPLANS} replans: ${planProblem(context.tasks)}`,
                  abandoned: [
                    ...context.abandoned,
                    { plan: context.plans, reason: `invalid plan: ${planProblem(context.tasks)}` },
                  ],
                },
              }
            : {
                target: "planning",
                context: {
                  replans: context.replans + 1,
                  feedback: `The previous plan was invalid: ${planProblem(context.tasks)}.`,
                  abandoned: [
                    ...context.abandoned,
                    { plan: context.plans, reason: `invalid plan: ${planProblem(context.tasks)}` },
                  ],
                },
              },
    },
    // One wave: spawn every task whose dependencies have landed, with its
    // `$N` placeholders filled from those results.
    dispatching: {
      entry: ({ context, actors }, enq) => {
        const wave = context.wave + 1;
        const scheduled = currentSchedule(context);
        const launched: Scheduled[] = readyTasks(context).map((task) => ({
          plan: context.plans,
          taskId: task.id,
          wave,
          tool: task.tool,
          args: substitute(task.args, scheduled),
          result: null,
        }));
        for (const entry of launched) {
          enq.spawn(actors.runTool, {
            id: taskActorId(entry.plan, entry.taskId),
            input: { tool: entry.tool, args: entry.args },
          });
        }
        return { context: { wave, schedule: [...context.schedule, ...launched] } };
      },
      always: { target: "collecting" },
    },
    // Land each task as it settles. A result that unblocks a task starts the
    // next wave; the last result goes to the joiner.
    collecting: {
      on: {
        "xstate.done.actor": ({ context, event }) => {
          const { actorId, output } = event as ToolDoneEvent;
          const schedule = landResult(context, actorId, output);
          if (schedule === null) return undefined;
          const next = { ...context, schedule };
          return allLanded(next)
            ? { target: "joining" as const, context: { schedule } }
            : readyTasks(next).length > 0
              ? { target: "dispatching" as const, context: { schedule } }
              : { context: { schedule } };
        },
        // A tool error is an observation the joiner can react to.
        "xstate.error.actor": ({ context, event }) => {
          const { actorId, error } = event as unknown as { actorId: string; error: unknown };
          const message = error instanceof Error ? error.message : String(error);
          const schedule = landResult(context, actorId, {
            observation: `[tool error] ${message}`,
            value: "error",
          });
          if (schedule === null) return undefined;
          const next = { ...context, schedule };
          return allLanded(next)
            ? { target: "joining" as const, context: { schedule } }
            : readyTasks(next).length > 0
              ? { target: "dispatching" as const, context: { schedule } }
              : { context: { schedule } };
        },
      },
    },
    joining: {
      invoke: {
        src: "join",
        input: ({ context }) => ({
          question: context.question,
          observations: renderObservations(context),
        }),
        onDone: ({ output }) => ({ target: "routingJoin", context: { verdict: output.result } }),
        onError: ({ event }) => ({
          target: "failed",
          context: { failure: `joiner failed: ${String(event.error)}` },
        }),
      },
    },
    // should_continue: finish with an answer, or replan while budget remains.
    routingJoin: {
      type: "choice",
      choice: ({ context }) =>
        context.verdict?.action === "finish" && context.verdict.answer
          ? { target: "done", context: { answer: context.verdict.answer } }
          : context.replans >= MAX_REPLANS
            ? {
                target: "failed",
                context: {
                  failure: `the joiner still asked to replan after ${MAX_REPLANS} replans`,
                  abandoned: [
                    ...context.abandoned,
                    {
                      plan: context.plans,
                      reason: `joiner: ${context.verdict?.feedback ?? "replan"}`,
                    },
                  ],
                },
              }
            : {
                target: "planning",
                context: {
                  replans: context.replans + 1,
                  feedback: context.verdict?.feedback ?? "The joiner asked for a new plan.",
                  abandoned: [
                    ...context.abandoned,
                    {
                      plan: context.plans,
                      reason: `joiner: ${context.verdict?.feedback ?? "replan"}`,
                    },
                  ],
                },
              },
    },
    done: {
      type: "final",
      output: ({ context }) => ({
        answer: context.answer ?? "",
        trail: renderTrail(context),
        plans: context.plans,
        tasksRun: context.schedule.length,
        waves: context.wave,
      }),
    },
    // Planner/joiner error or replan budget spent: say so, keep the trail.
    failed: {
      type: "final",
      output: ({ context }) => ({
        answer: `No answer: ${context.failure ?? "unknown failure"}.`,
        trail: renderTrail(context),
        plans: context.plans,
        tasksRun: context.schedule.length,
        waves: context.wave,
      }),
    },
  },
});

export interface RunLlmCompilerOptions {
  question?: string;
  /** Injected for tests; the direct run supplies a real model executor. */
  generateText?: AgentRequestExecutors["generateText"];
  /** Observes each machine transition. */
  onProgress?: (state: string) => void;
}

export interface LlmCompilerResult {
  answer: string;
  trail: string;
  plans: number;
  tasksRun: number;
  waves: number;
  /** Every state the run passed through; the last one is `done` or `failed`. */
  progress: string[];
  /** Every task spawned, with its wave. */
  schedule: Scheduled[];
}

/** Runs the compiler loop; records state progress and the task schedule. */
export async function runLlmCompilerExample(
  options: RunLlmCompilerOptions = {},
): Promise<LlmCompilerResult> {
  const {
    question = "What is the combined population of France and Germany?",
    generateText,
    onProgress,
  } = options;

  const progress: string[] = [];
  const result = await runToQuiescence(
    createAgentRuntime(llmCompilerMachine, {
      ...(generateText
        ? { executors: { generateText } }
        : { executors: createAiSdkExecutors({ models }) }),
      onTransition: (snapshot) => {
        const state = getStatePath(snapshot);
        progress.push(state);
        onProgress?.(state);
      },
    }),
    {
      input: { question },
    },
  );

  if (result.status !== "done") {
    throw new Error(`LLMCompiler example did not complete: ${result.status}`);
  }
  return { ...result.output, progress, schedule: result.snapshot.context.schedule };
}

// Run directly (`tsx index.ts`); skipped when a test imports this module.
if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  if (!process.env.OPENAI_API_KEY) {
    console.error("Set OPENAI_API_KEY to run this example.");
    process.exit(1);
  }
  void (async () => {
    const result = await runLlmCompilerExample({
      onProgress: (state) => console.log(`  → ${state}`),
    });
    console.log(`\n${result.trail}\n\nAnswer: ${result.answer}`);
    console.log(`(${result.plans} plan(s), ${result.tasksRun} task(s), ${result.waves} wave(s))`);
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
