/**
 * Agent supervisor — one supervisor model routes a task between two worker
 * agents (a researcher and a coder), one worker at a time, until it decides
 * the task is finished.
 *
 * Ported from LangGraph's "Multi-agent supervisor" tutorial (and the
 * `langgraph-supervisor` library). There, a supervisor LLM with structured
 * output `next ∈ {researcher, coder, FINISH}` picks the next worker; each
 * worker is a ReAct agent with its own tools; every worker hands control back
 * to the supervisor. The loop is bounded only by `recursion_limit`.
 *
 * Not the same as `hierarchical-teams`: that example nests managers (a
 * coordinator over two team machines, each with its own supervisor). This one
 * is FLAT — one supervisor, two workers — and every routing choice is an
 * `agent.decide` filtered by guards, not a manager machine.
 *
 * LangGraph shape:
 *
 *   START → supervisor ─┬─ researcher ─┐
 *              ▲        ├─ coder ──────┤
 *              └────────┴──────────────┘
 *                       └─ FINISH → END
 *
 * Machine shape:
 *
 *   checkingBudget ─┬─ supervising ─┬─ DELEGATE_RESEARCH → researching ─┐
 *        ▲          │               ├─ DELEGATE_CODE     → coding ──────┤
 *        │          │               └─ FINISH            → done         │
 *        │          └─ failed (no usable report)                        │
 *        └──────────────────────────────────────────────────────────────┘
 *
 *   researcherMachine: lookingUp → reporting → done | failed
 *   coderMachine:      analyzing → reporting → done | failed
 *
 * What maps to what:
 *   - supervisor node (structured `next`) → `supervising`: `agent.decide`
 *     named `routeWork` over DELEGATE_RESEARCH / DELEGATE_CODE / FINISH
 *   - FINISH's final message            → the FINISH event's `answer` payload
 *   - researcher ReAct agent            → `researcherMachine`, an invoked child
 *     machine: a keyword-lookup tool actor, then one `writeResearchReport` request
 *   - coder ReAct agent + Python REPL   → `coderMachine`: a hand-written
 *     analysis actor (sum/average), then one `writeAnalysisReport` request
 *   - worker → supervisor edges         → each worker invoke's `onDone`, which
 *     appends the report to `context.reports` and returns to `checkingBudget`
 *   - recursion_limit                   → `MAX_TURNS`, a cap on delegations:
 *     guards refuse a delegation past it, and `checkingBudget` sends a run
 *     with no usable report to `failed`; otherwise the supervisor still
 *     gets its FINISH after the last permitted worker reports
 *
 * Differences from LangGraph worth calling out:
 *   - Routing rules are guards, not prompt text. A worker that has already
 *     reported `MAX_CALLS_PER_WORKER` times cannot be picked again, and FINISH
 *     is rejected until at least one worker has reported. A rejected pick is
 *     retried by `agent.decide`; it never reaches the graph.
 *   - The allowance counts SUCCESSFUL reports. A worker that errors records a
 *     failed report and does not use up its allowance, so the turn budget is
 *     what bounds retries of a flaky worker, and exhausting it lands in
 *     `failed` with the reports gathered so far.
 *   - Each worker runs its tool once, then writes one report. LangGraph's
 *     ReAct workers may call tools several times per turn; a worker here is
 *     the smallest honest version of that loop, and the tool call is a state
 *     you can point at.
 *
 * Stand-ins: `SAMPLE_NOTES` is a tiny in-file corpus of fictional quarterly
 * metrics for a made-up product (the Lumen desk lamp). The researcher's tool
 * is keyword overlap over it (results prefixed `[sample note]`), and the
 * coder's tool parses the numbers out of matching notes and computes sum and
 * average in plain TypeScript (results prefixed `[sample analysis]`). No
 * network, no code execution.
 *
 * Dual-mode: `runAgentSupervisorExample(options?)` takes injectable
 * `generateText` / `decide` executors (tests script them); the direct run
 * uses real models.
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/agent-supervisor/index.ts
 */
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { createAsyncLogic } from "xstate";
import { createAiSdkExecutors } from "@statelyai/agent/ai-sdk";
import { getStatePath, runAgent, setupAgent, type AgentRequestExecutors } from "@statelyai/agent";

const models = {
  supervisor: openai("gpt-6-luna"),
  worker: openai("gpt-6-luna"),
};

/** Successful reports a single worker may contribute before it can't be picked again. */
export const MAX_CALLS_PER_WORKER = 2;
/** Delegations the supervisor may make before the run ends in `failed`. */
export const MAX_TURNS = 5;

/**
 * Sample data: fictional quarterly notes for a made-up product. Stand-in for
 * the researcher's search tool. Numbers follow the last colon so the coder's
 * analysis can parse them.
 */
export const SAMPLE_NOTES: Array<{ id: string; text: string }> = [
  {
    id: "q1-revenue",
    text: "Lumen lamp Q1 revenue by month, in thousands of dollars: 120, 135, 150",
  },
  {
    id: "q2-revenue",
    text: "Lumen lamp Q2 revenue by month, in thousands of dollars: 160, 170, 185",
  },
  {
    id: "q2-churn",
    text: "Lumen lamp subscription churn by month in Q2, in percent: 3.1, 2.8, 2.6",
  },
  {
    id: "q2-support",
    text: "Lumen lamp support tickets per week after the Q2 firmware release: 48, 41, 36, 31",
  },
  {
    id: "q2-launch",
    text: "Lumen lamp launched a warm-white variant in Q2; reviewers praised the dimmer and criticized the short cable.",
  },
];

const STOP_WORDS = new Set([
  "in",
  "of",
  "to",
  "by",
  "is",
  "did",
  "the",
  "and",
  "for",
  "what",
  "how",
  "was",
  "were",
  "are",
  "does",
  "its",
  "with",
  "from",
  "about",
  "per",
  "lumen",
  "lamp",
]);

type Note = { id: string; text: string };

/** Honest keyword overlap (NOT embeddings): shared content words, highest first. */
function scoreNotes(query: string): Array<{ note: Note; score: number }> {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word));
  return SAMPLE_NOTES.map((note) => ({
    note,
    score: terms.filter((term) => note.text.toLowerCase().includes(term)).length,
  }))
    .filter((scored) => scored.score > 0)
    .sort((left, right) => right.score - left.score);
}

/** The researcher's lookup: up to three notes sharing a content word with the query. */
export function lookUpNotes(query: string): Note[] {
  return scoreNotes(query)
    .slice(0, 3)
    .map((scored) => scored.note);
}

/** The coder's input: only the notes tied for the best score, so one series wins. */
function bestNotes(query: string): Note[] {
  const scored = scoreNotes(query);
  const top = scored[0]?.score ?? 0;
  return scored.filter((entry) => entry.score === top).map((entry) => entry.note);
}

/** Numbers after a note's last colon; empty when the note carries no series. */
function seriesIn(text: string): number[] {
  const colon = text.lastIndexOf(":");
  if (colon === -1) return [];
  return (text.slice(colon + 1).match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
}

/** Hand-written stand-in for the coder's code tool: sum and average per series. */
export function analyzeNotes(query: string): string[] {
  const lines = bestNotes(query)
    .map((note) => ({ id: note.id, values: seriesIn(note.text) }))
    .filter((entry) => entry.values.length > 0)
    .map(({ id, values }) => {
      const sum = Math.round(values.reduce((total, value) => total + value, 0) * 100) / 100;
      const average = Math.round((sum / values.length) * 100) / 100;
      return `[sample analysis] ${id}: n=${values.length}, sum=${sum}, average=${average}`;
    });
  return lines.length > 0 ? lines : ["[sample analysis] No numeric series matched this task."];
}

// ─── Workers ────────────────────────────────────────────────────────────────

const workerInput = z.object({ task: z.string(), priorReports: z.array(z.string()) });
const workerOutput = z.object({ report: z.string(), status: z.enum(["done", "failed"]) });
const workerContext = z.object({
  task: z.string(),
  priorReports: z.array(z.string()),
  toolResults: z.array(z.string()),
  report: z.string().nullable(),
  failure: z.string().nullable(),
});

const researcherSetup = setupAgent({
  models,
  context: workerContext,
  input: workerInput,
  output: workerOutput,
  actors: {
    // The researcher's tool: keyword lookup over SAMPLE_NOTES.
    lookUpNotes: createAsyncLogic<string[], { query: string }>({
      run: async ({ input }) => {
        const hits = lookUpNotes(input.query);
        return hits.length > 0
          ? hits.map((note) => `[sample note] ${note.text}`)
          : ["[sample note] No notes matched this task."];
      },
    }),
  },
  requests: {
    writeResearchReport: {
      schemas: {
        input: z.object({ task: z.string(), notes: z.array(z.string()) }),
        output: z.string(),
      },
      model: "worker",
      system:
        "You are a researcher. Report the facts in the notes that bear on the task, in at most " +
        "three sentences. Do not do arithmetic; a coder will. Say so plainly if the notes are silent.",
      prompt: ({ input }) => `Task: ${input.task}\n\nNotes:\n${input.notes.join("\n")}`,
    },
  },
});

/** The researcher worker: one tool call, one report. */
export const researcherMachine = researcherSetup.createMachine({
  id: "researcher",
  context: ({ input }) => ({
    task: input.task,
    priorReports: input.priorReports,
    toolResults: [],
    report: null,
    failure: null,
  }),
  initial: "lookingUp",
  states: {
    lookingUp: {
      invoke: {
        src: "lookUpNotes",
        input: ({ context }) => ({ query: context.task }),
        onDone: ({ output }) => ({ target: "reporting", context: { toolResults: output } }),
        onError: ({ event }) => ({
          target: "failed",
          context: { failure: `note lookup failed: ${String(event.error)}` },
        }),
      },
    },
    reporting: {
      invoke: {
        src: "writeResearchReport",
        input: ({ context }) => ({ task: context.task, notes: context.toolResults }),
        onDone: ({ output }) => ({ target: "done", context: { report: output.result } }),
        onError: ({ event }) => ({
          target: "failed",
          context: { failure: `writeResearchReport failed: ${String(event.error)}` },
        }),
      },
    },
    done: {
      type: "final",
      output: ({ context }) => ({ report: context.report ?? "", status: "done" as const }),
    },
    failed: {
      type: "final",
      output: ({ context }) => ({
        report: `The researcher could not finish (${context.failure ?? "unknown error"}).`,
        status: "failed" as const,
      }),
    },
  },
});

const coderSetup = setupAgent({
  models,
  context: workerContext,
  input: workerInput,
  output: workerOutput,
  actors: {
    // The coder's tool: plain TypeScript arithmetic over the matching series.
    runAnalysis: createAsyncLogic<string[], { query: string }>({
      run: async ({ input }) => analyzeNotes(input.query),
    }),
  },
  requests: {
    writeAnalysisReport: {
      schemas: {
        input: z.object({
          task: z.string(),
          analysis: z.array(z.string()),
          priorReports: z.array(z.string()),
        }),
        output: z.string(),
      },
      model: "worker",
      system:
        "You are a coder. Your analysis tool already computed the numbers. Explain what they " +
        "show for the task in at most three sentences, quoting the computed values exactly.",
      prompt: ({ input }) =>
        [
          `Task: ${input.task}`,
          "",
          "Analysis output:",
          ...input.analysis,
          "",
          "Earlier reports:",
          ...(input.priorReports.length > 0 ? input.priorReports : ["(none)"]),
        ].join("\n"),
    },
  },
});

/** The coder worker: one analysis run, one report. */
export const coderMachine = coderSetup.createMachine({
  id: "coder",
  context: ({ input }) => ({
    task: input.task,
    priorReports: input.priorReports,
    toolResults: [],
    report: null,
    failure: null,
  }),
  initial: "analyzing",
  states: {
    analyzing: {
      invoke: {
        src: "runAnalysis",
        input: ({ context }) => ({ query: context.task }),
        onDone: ({ output }) => ({ target: "reporting", context: { toolResults: output } }),
        onError: ({ event }) => ({
          target: "failed",
          context: { failure: `analysis failed: ${String(event.error)}` },
        }),
      },
    },
    reporting: {
      invoke: {
        src: "writeAnalysisReport",
        input: ({ context }) => ({
          task: context.task,
          analysis: context.toolResults,
          priorReports: context.priorReports,
        }),
        onDone: ({ output }) => ({ target: "done", context: { report: output.result } }),
        onError: ({ event }) => ({
          target: "failed",
          context: { failure: `writeAnalysisReport failed: ${String(event.error)}` },
        }),
      },
    },
    done: {
      type: "final",
      output: ({ context }) => ({ report: context.report ?? "", status: "done" as const }),
    },
    failed: {
      type: "final",
      output: ({ context }) => ({
        report: `The coder could not finish (${context.failure ?? "unknown error"}).`,
        status: "failed" as const,
      }),
    },
  },
});

// ─── Supervisor ─────────────────────────────────────────────────────────────

const workerName = z.enum(["researcher", "coder"]);
type WorkerName = z.infer<typeof workerName>;

const reportSchema = z.object({
  worker: workerName,
  report: z.string(),
  status: z.enum(["done", "failed"]),
});
type Report = z.infer<typeof reportSchema>;

const supervisorContext = z.object({
  task: z.string(),
  reports: z.array(reportSchema),
  /** Delegations made so far, compared against MAX_TURNS. */
  turns: z.number().int(),
  answer: z.string().nullable(),
  /** The one human-readable progress line. */
  notice: z.string(),
});
type SupervisorContext = z.infer<typeof supervisorContext>;

/** Successful reports from `worker` — what the per-worker allowance counts. */
function callsFor(reports: Report[], worker: WorkerName): number {
  return reports.filter((entry) => entry.worker === worker && entry.status === "done").length;
}

function hasReport(reports: Report[]): boolean {
  return reports.some((entry) => entry.status === "done");
}

function oneLine(text: string, max = 100): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function renderRoutingPrompt(context: SupervisorContext): string {
  return [
    `Task: ${context.task}`,
    `Turns used: ${context.turns} of ${MAX_TURNS}.`,
    `Researcher reports: ${callsFor(context.reports, "researcher")} of ${MAX_CALLS_PER_WORKER}. ` +
      `Coder reports: ${callsFor(context.reports, "coder")} of ${MAX_CALLS_PER_WORKER}.`,
    "",
    "Worker reports so far:",
    ...(context.reports.length > 0
      ? context.reports.map(
          (entry, i) => `[${i + 1}] ${entry.worker} (${entry.status}): ${entry.report}`,
        )
      : ["(none yet)"]),
    "",
    "Choose DELEGATE_RESEARCH to gather facts, DELEGATE_CODE to compute numbers, or FINISH " +
      "with the final answer once the reports cover the task. FINISH needs at least one report.",
  ].join("\n");
}

/** One line per delegation, rendered from the reports in `output`. */
function renderTrail(context: SupervisorContext): string[] {
  return [
    ...context.reports.map(
      (entry, i) => `turn ${i + 1}: ${entry.worker} ${entry.status}. ${oneLine(entry.report)}`,
    ),
    context.notice,
  ];
}

const agentSetup = setupAgent({
  models,
  context: supervisorContext,
  input: z.object({ task: z.string() }),
  output: z.object({
    answer: z.string(),
    reports: z.array(reportSchema),
    turns: z.number().int(),
    trail: z.array(z.string()),
  }),
  events: {
    DELEGATE_RESEARCH: z.object({}),
    DELEGATE_CODE: z.object({}),
    FINISH: z.object({ answer: z.string() }),
  },
  actors: { researcher: researcherMachine, coder: coderMachine },
});

export const agentSupervisorSchemas = agentSetup.schemas;

/** Worker input: the task plus the successful reports so far. */
function workerInputFrom(context: SupervisorContext) {
  return {
    task: context.task,
    priorReports: context.reports
      .filter((entry) => entry.status === "done")
      .map((entry) => `${entry.worker}: ${entry.report}`),
  };
}

/** The worker → supervisor edge: append the report and say what happened. */
function recordReport(
  context: SupervisorContext,
  worker: WorkerName,
  output: { report: string; status: "done" | "failed" },
) {
  const reports = [...context.reports, { worker, ...output }];
  return {
    target: "checkingBudget" as const,
    context: {
      reports,
      notice:
        output.status === "done"
          ? `The ${worker} reported (${callsFor(reports, worker)} of ${MAX_CALLS_PER_WORKER}).`
          : `The ${worker} failed; its allowance is unchanged.`,
    },
  };
}

export const agentSupervisorMachine = agentSetup.createMachine({
  id: "agent-supervisor",
  context: ({ input }) => ({
    task: input.task,
    reports: [],
    turns: 0,
    answer: null,
    notice: "Waiting for the supervisor's first routing choice.",
  }),
  initial: "checkingBudget",
  states: {
    // recursion_limit, made a state. The budget caps DELEGATIONS, not the
    // finish: once MAX_TURNS workers have run, the supervisor still sees the
    // last report and may FINISH. Only when the budget is spent with nothing
    // usable to finish from does the run fail here.
    checkingBudget: {
      type: "choice",
      choice: ({ context }) =>
        context.turns >= MAX_TURNS && !hasReport(context.reports)
          ? {
              target: "failed",
              context: {
                notice: `Turn budget spent: ${MAX_TURNS} delegations without a usable report.`,
              },
            }
          : { target: "supervising" },
    },
    // The supervisor: one model-chosen event per turn, filtered by guards.
    supervising: {
      invoke: {
        src: "agent.decide",
        input: ({ context }) => ({
          model: "supervisor",
          name: "routeWork",
          system:
            "You supervise two workers: a researcher who looks up notes, and a coder who " +
            "computes sums and averages. Route one worker at a time, then FINISH with the answer.",
          prompt: renderRoutingPrompt(context),
          // At the cap, only FINISH is offered; the guards below enforce it too.
          allowedEvents:
            context.turns >= MAX_TURNS
              ? ["FINISH"]
              : ["DELEGATE_RESEARCH", "DELEGATE_CODE", "FINISH"],
        }),
        onError: {
          target: "failed",
          context: { notice: "The supervisor made no legal routing choice." },
        },
      },
      on: {
        // A delegation needs budget left AND the worker's own allowance.
        DELEGATE_RESEARCH: ({ context }) =>
          context.turns < MAX_TURNS &&
          callsFor(context.reports, "researcher") < MAX_CALLS_PER_WORKER
            ? { target: "researching", context: { turns: context.turns + 1 } }
            : undefined,
        DELEGATE_CODE: ({ context }) =>
          context.turns < MAX_TURNS && callsFor(context.reports, "coder") < MAX_CALLS_PER_WORKER
            ? { target: "coding", context: { turns: context.turns + 1 } }
            : undefined,
        FINISH: ({ context, event }) =>
          hasReport(context.reports)
            ? {
                target: "done",
                context: { answer: event.answer, notice: "The supervisor finished the task." },
              }
            : undefined,
      },
    },
    researching: {
      invoke: {
        id: "researcher",
        src: "researcher",
        input: ({ context }) => workerInputFrom(context),
        onDone: ({ context, output }) => recordReport(context, "researcher", output),
        onError: ({ context, event }) =>
          recordReport(context, "researcher", {
            report: `The researcher crashed (${String(event.error)}).`,
            status: "failed",
          }),
      },
    },
    coding: {
      invoke: {
        id: "coder",
        src: "coder",
        input: ({ context }) => workerInputFrom(context),
        onDone: ({ context, output }) => recordReport(context, "coder", output),
        onError: ({ context, event }) =>
          recordReport(context, "coder", {
            report: `The coder crashed (${String(event.error)}).`,
            status: "failed",
          }),
      },
    },
    done: {
      type: "final",
      output: ({ context }) => ({
        answer: context.answer ?? "",
        reports: context.reports,
        turns: context.turns,
        trail: renderTrail(context),
      }),
    },
    // Best effort: no FINISH, but the reports gathered so far are returned.
    failed: {
      type: "final",
      output: ({ context }) => {
        const last = context.reports.filter((entry) => entry.status === "done").at(-1);
        return {
          answer:
            `No final answer: ${context.notice}` +
            (last ? ` Last ${last.worker} report: ${last.report}` : " No worker reported."),
          reports: context.reports,
          turns: context.turns,
          trail: renderTrail(context),
        };
      },
    },
  },
});

export interface RunAgentSupervisorOptions {
  task?: string;
  /** Injected for tests; direct run supplies a real model executor. */
  generateText?: AgentRequestExecutors["generateText"];
  /** Injected for tests; drives the supervisor's routing decisions. */
  decide?: AgentRequestExecutors["decide"];
  /** Observes each supervisor-level transition. */
  onProgress?: (state: string) => void;
}

/** Runs the supervisor loop; `outcome` says which final state it reached. */
export async function runAgentSupervisorExample(options: RunAgentSupervisorOptions = {}) {
  const {
    task = "What was the Lumen lamp's average monthly revenue in Q2?",
    generateText,
    decide,
    onProgress,
  } = options;

  // Mocks REPLACE the real executors rather than layering over them.
  const executors =
    generateText || decide
      ? { ...(generateText ? { generateText } : {}), ...(decide ? { decide } : {}) }
      : createAiSdkExecutors({ models });

  const progress: string[] = [];
  const result = await runAgent(agentSupervisorMachine, {
    input: { task },
    executors,
    onTransition: (snapshot) => {
      const state = getStatePath(snapshot);
      progress.push(state);
      onProgress?.(state);
    },
  });

  if (result.status !== "done") {
    throw new Error(`Agent supervisor did not complete: ${result.status}`);
  }
  return { outcome: getStatePath(result.snapshot), ...result.output, progress };
}

// Run directly (`tsx index.ts`); skipped when a test imports this module.
if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  if (!process.env.OPENAI_API_KEY) {
    console.error("Set OPENAI_API_KEY to run this example.");
    process.exit(1);
  }
  void runAgentSupervisorExample({ onProgress: (state) => console.log(`  → ${state}`) })
    .then(({ outcome, answer, trail }) => {
      console.log(`\n[${outcome}] ${answer}\n\n${trail.join("\n")}`);
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
