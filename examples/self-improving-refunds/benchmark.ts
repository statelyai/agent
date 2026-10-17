/**
 * The benchmark: the same train and held-out scenarios through six arms, in order.
 *
 *   A   a raw AI SDK tool loop, rules in the prompt only (raw-loop.ts)
 *   B   the desk, with the raw model choosing among the legal options (one `choose_option` tool)
 *   J   the desk, with a decision model (Jev) judging the options, each described with what it changes
 *   J−  J without the lookahead: the ablation row, how much the machine-derived effects contribute
 *   C0  the desk, with playbook v0 deciding
 *   Ck  the desk, with the playbook in force after `rounds` of improvePlaybook
 *
 * Every desk arm journals to one event-log store, one thread per arm and
 * scenario. C0 and Ck are measured inside the improvement loop rather than
 * re-run: C0 is the first round's `before`, Ck the last measurement of the
 * playbook in force.
 *
 * Run: OPENAI_API_KEY=... TYPESAFE_AI_API_KEY=... pnpm exec tsx examples/self-improving-refunds/benchmark.ts
 */
import { openai } from "@ai-sdk/openai";
import { typeSafeAi } from "@ai-sdk/typesafe-ai";
import type { Experimental_DecisionModel, LanguageModel } from "ai";
import type {
  AgentDecisionExecutor,
  AgentEventLogStore,
  AgentWorkflowConfig,
} from "@statelyai/agent";
import { createAiSdkExecutors, createDecisionModelDecide } from "@statelyai/agent/ai-sdk";
import { createInMemoryEventLogStore } from "@statelyai/agent/log";
import {
  HELD_OUT_SCENARIOS,
  runSplits,
  SCENARIOS,
  type Arm,
  type Scenario,
  type SplitMetrics,
} from "./contract.js";
import { createDeskArm } from "./desk.js";
import { improvePlaybook, objective, type ImprovementResult } from "./improve.js";
import { loadPlaybook, type PlaybookExecutors } from "./playbook.js";
import { createRawLoopArm } from "./raw-loop.js";

export { createRawLoopArm };

type DeskArmOptions = { store?: AgentEventLogStore; label?: string };

/** Arm B: the desk with a model decider, each decide call counted as a model call. */
export function createModelDeskArm(
  decide: AgentDecisionExecutor,
  options: DeskArmOptions = {},
): Arm {
  let modelCalls = 0;
  return createDeskArm({
    label: options.label ?? "B: desk + raw model",
    threadPrefix: "B",
    name: "rawModel",
    decide: (request, info) => {
      modelCalls += 1;
      return decide(request, info);
    },
    counters: () => ({ modelCalls, judgeCalls: 0 }),
    ...(options.store ? { store: options.store } : {}),
  });
}

/**
 * Arms J and J−: the desk with a decision model judging the closed choice.
 * `lookahead` adds each option's machine-derived effect (`Then: state: …`) to
 * its criterion; each decide call is one judge call.
 */
export function createJudgeDeskArm(
  judge: Experimental_DecisionModel,
  options: DeskArmOptions & { lookahead: boolean; minConfidence?: number },
): Arm {
  const decide = createDecisionModelDecide(
    judge,
    options.minConfidence === undefined ? {} : { minConfidence: options.minConfidence },
  );
  let judgeCalls = 0;
  return createDeskArm({
    label: options.label ?? (options.lookahead ? "J: desk + Jev" : "J−: desk + Jev, no lookahead"),
    threadPrefix: options.lookahead ? "J" : "J-",
    name: "jev",
    lookahead: options.lookahead,
    decide: (request, info) => {
      judgeCalls += 1;
      return decide(request, info);
    },
    counters: () => ({ modelCalls: 0, judgeCalls }),
    ...(options.store ? { store: options.store } : {}),
  });
}

export type BenchmarkOptions = {
  /** Arm A's model, arm B's model, and the model behind the default executors. */
  textModel: LanguageModel;
  /** The decision model behind arms J/J− and the playbooks' `classifyTicket`. */
  judge: Experimental_DecisionModel;
  /** The `proposePlaybook` reflection model. Defaults to the executors' model. */
  reflectionModel?: LanguageModel;
  /** Executors for arm B and the playbooks. Defaults to `createAiSdkExecutors` over `textModel`. */
  executors?: PlaybookExecutors;
  train?: Scenario[];
  heldOut?: Scenario[];
  /** Improvement rounds; stops early at the first round that does not promote. */
  rounds?: number;
  /** Where every desk episode is journaled. Default: a fresh in-memory store. */
  store?: AgentEventLogStore;
  log?: (line: string) => void;
};

export type ArmReport = SplitMetrics & { label: string };

export type BenchmarkReport = {
  arms: ArmReport[];
  improvements: ImprovementResult[];
  store: AgentEventLogStore;
};

export async function runBenchmark(options: BenchmarkOptions): Promise<BenchmarkReport> {
  const {
    textModel,
    judge,
    train = SCENARIOS,
    heldOut = HELD_OUT_SCENARIOS,
    rounds = 2,
    store = createInMemoryEventLogStore(),
    log = () => {},
  } = options;
  const base = options.executors ?? createAiSdkExecutors({ resolveModel: () => textModel });
  const reflection = options.reflectionModel
    ? createAiSdkExecutors({ resolveModel: () => options.reflectionModel! })
    : undefined;
  const executors: PlaybookExecutors = reflection
    ? {
        decide: base.decide,
        generateText: (request, info) =>
          request.name === "proposePlaybook"
            ? reflection.generateText({ ...request, tools: request.tools ?? {} }, info)
            : base.generateText(request, info),
      }
    : base;

  const arms: ArmReport[] = [];
  const record = (label: string, metrics: SplitMetrics) => {
    const row = { ...metrics, label };
    arms.push(row);
    log(summaryLine(row));
  };
  const run = async (arm: Arm) => record(arm.label, await runSplits(arm, train, heldOut));

  await run(createRawLoopArm({ model: textModel }));
  await run(createModelDeskArm(executors.decide, { store }));
  await run(createJudgeDeskArm(judge, { store, lookahead: true }));
  await run(createJudgeDeskArm(judge, { store, lookahead: false }));

  let current: AgentWorkflowConfig = loadPlaybook("v0");
  const improvements: ImprovementResult[] = [];
  for (let round = 1; round <= rounds; round++) {
    const result = await improvePlaybook({
      current,
      executors,
      judge,
      train,
      heldOut,
      store,
      runId: `round-${round}`,
    });
    improvements.push(result);
    log(improvementLine(round, result));
    if (round === 1) record(`C0: desk + ${playbookName(current)}`, result.before);
    current = result.config;
    if (!result.promoted) break;
  }

  const last = improvements.at(-1);
  if (last) {
    const promoted = improvements.filter((result) => result.promoted).length;
    record(
      `C${promoted}: desk + ${playbookName(current)}`,
      last.promoted ? last.after! : last.before,
    );
  }

  return { arms, improvements, store };
}

const playbookName = (config: AgentWorkflowConfig) => config.id ?? "playbook";

const pct = (value: number) => `${Math.round(value * 100)}%`;
const fmt = (value: number) => (Number.isFinite(value) ? value.toFixed(3) : "-inf");

function summaryLine(arm: ArmReport): string {
  const { all } = arm;
  return (
    `${arm.label}: accuracy ${pct(arm.train.accuracy)} train / ${pct(arm.heldOut.accuracy)} held-out, ` +
    `${all.violations} violations, ${all.modelCalls} model calls, ${all.judgeCalls} judge calls, ` +
    `${all.rejections} rejections, objective ${fmt(objective(all))}`
  );
}

function improvementLine(round: number, result: ImprovementResult): string {
  const failed = result.gates.filter((gate) => !gate.ok).map((gate) => gate.name);
  const after = result.after ? fmt(objective(result.after.all)) : "not replayed";
  return (
    `round ${round}: ${result.promoted ? "promoted" : "not promoted"}` +
    `${result.proposed?.id ? ` ${result.proposed.id}` : ""}` +
    `${failed.length ? `, gates failed: ${failed.join(", ")}` : ""}` +
    `${result.repairs ? `, ${result.repairs} repair(s)` : ""}` +
    `, objective ${fmt(objective(result.before.all))} -> ${after}`
  );
}

/** A markdown table of the arms, then one line per improvement round. */
export function formatReport(report: Pick<BenchmarkReport, "arms" | "improvements">): string {
  const row = (arm: ArmReport) => {
    const { all } = arm;
    return (
      `| ${arm.label} | ${pct(arm.train.accuracy)} | ${pct(arm.heldOut.accuracy)} | ${all.violations} | ` +
      `${all.modelCalls} | ${all.judgeCalls} | ${all.rejections} | ${fmt(objective(all))} |`
    );
  };
  return [
    "| arm | accuracy (train) | accuracy (held-out) | violations | model calls | judge calls | rejections | objective |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...report.arms.map(row),
    "",
    ...report.improvements.map((result, index) => `- ${improvementLine(index + 1, result)}`),
  ].join("\n");
}

// Run directly (`tsx benchmark.ts`); skipped when a test imports this module.
if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  if (!process.env.OPENAI_API_KEY || !process.env.TYPESAFE_AI_API_KEY) {
    console.error("Set OPENAI_API_KEY and TYPESAFE_AI_API_KEY to run the benchmark.");
    process.exit(1);
  }
  runBenchmark({
    textModel: openai("gpt-5.4-mini"),
    judge: typeSafeAi.decisionModel("jev-latest"),
    log: (line) => console.log(line),
  })
    .then((report) => console.log(`\n${formatReport(report)}`))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
