/**
 * The benchmark: the same scenarios through four arms, in order.
 *
 *   A   a raw AI SDK tool loop, rules in the prompt only (raw-loop.ts)
 *   B   the desk, with the raw model proposing each turn and the guards rejecting
 *   C0  the desk, with playbook v0 deciding
 *   Ck  the desk, with the playbook in force after `rounds` of improvePlaybook
 *
 * The desk arms share one set of executors (`createAiSdkExecutors` over
 * `textModel` unless the caller passes its own). C0 and Ck are measured
 * inside the improvement loop rather than re-run: C0 is the first round's
 * `before`, and Ck is the last measurement of the playbook in force.
 */
import type { Experimental_DecisionModel, LanguageModel } from "ai";
import type { AgentDecisionExecutor, AgentWorkflowConfig } from "@statelyai/agent";
import { createAiSdkExecutors } from "@statelyai/agent/ai-sdk";
import { runBatch, SCENARIOS, type Arm, type BatchMetrics, type Scenario } from "./contract.js";
import { createDeskArm } from "./desk.js";
import { improvePlaybook, type ImprovementResult } from "./improve.js";
import {
  createPlaybookDecide,
  loadPlaybook,
  type PlaybookDecide,
  type PlaybookExecutors,
} from "./playbook.js";
import { createRawLoopArm } from "./raw-loop.js";

export { createRawLoopArm };

/** Arm B: the desk with a model decider, each decide call counted as a model call. */
export function createModelDeskArm(
  decide: AgentDecisionExecutor,
  label = "B: desk + raw model",
): Arm {
  let modelCalls = 0;
  return createDeskArm({
    label,
    decide: (request, info) => {
      modelCalls += 1;
      return decide(request, info);
    },
    counters: () => ({ modelCalls, judgeCalls: 0 }),
  });
}

/** An arm C: the desk with a playbook decider, counted by the playbook's own counters. */
export function createPlaybookArm(decide: PlaybookDecide, label?: string): Arm {
  return createDeskArm({
    label: label ?? `desk + ${decide.config.id ?? "playbook"}`,
    decide,
    // A copy: runDeskEpisode diffs two readings, and `decide.counters` mutates in place.
    counters: () => ({ ...decide.counters }),
  });
}

export type BenchmarkOptions = {
  /** Arm A's model, and the model behind the default executors. */
  textModel: LanguageModel;
  /** The judge behind the playbooks' `classifyTicket`. */
  judge: Experimental_DecisionModel;
  /** The `proposePlaybook` reflection model. Defaults to the executors' model. */
  reflectionModel?: LanguageModel;
  /** Executors for the desk arms. Defaults to `createAiSdkExecutors` over `textModel`. */
  executors?: PlaybookExecutors;
  scenarios?: Scenario[];
  /** Improvement rounds; stops early at the first round that does not promote. */
  rounds?: number;
  log?: (line: string) => void;
};

export type BenchmarkReport = {
  arms: BatchMetrics[];
  improvements: ImprovementResult[];
};

export async function runBenchmark(options: BenchmarkOptions): Promise<BenchmarkReport> {
  const { textModel, judge, scenarios = SCENARIOS, rounds = 2, log = () => {} } = options;
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

  const arms: BatchMetrics[] = [];
  const record = (metrics: BatchMetrics) => {
    arms.push(metrics);
    log(summaryLine(metrics));
  };

  record(await runBatch(createRawLoopArm({ model: textModel }), scenarios));
  record(await runBatch(createModelDeskArm(executors.decide), scenarios));

  let current: AgentWorkflowConfig = loadPlaybook("v0");
  const improvements: ImprovementResult[] = [];
  for (let round = 1; round <= rounds; round++) {
    const result = await improvePlaybook({
      current,
      arm: (decide) => createPlaybookArm(decide),
      executors,
      judge,
      scenarios,
    });
    improvements.push(result);
    log(improvementLine(round, result));
    if (round === 1) record({ ...result.before, label: `C0: desk + ${playbookName(current)}` });
    current = result.config;
    if (!result.promoted) break;
  }

  const last = improvements.at(-1);
  if (last) {
    const promoted = improvements.filter((result) => result.promoted).length;
    const measured = last.promoted ? last.after! : last.before;
    record({ ...measured, label: `C${promoted}: desk + ${playbookName(current)}` });
  } else {
    // No rounds: still measure v0 so the table has its C row.
    const decide = createPlaybookDecide(current, { executors, judge });
    record({
      ...(await runBatch(createPlaybookArm(decide), scenarios)),
      label: `C0: desk + ${playbookName(current)}`,
    });
  }

  return { arms, improvements };
}

const playbookName = (config: AgentWorkflowConfig) => config.id ?? "playbook";

const cost = (metrics: BatchMetrics) =>
  metrics.modelCalls + metrics.judgeCalls + metrics.rejections;

function summaryLine(metrics: BatchMetrics): string {
  return (
    `${metrics.label}: accuracy ${pct(metrics.accuracy)}, ${metrics.violations} violations, ` +
    `${metrics.modelCalls} model calls, ${metrics.judgeCalls} judge calls, ${metrics.rejections} rejections`
  );
}

function improvementLine(round: number, result: ImprovementResult): string {
  const failed = result.gates.filter((gate) => !gate.ok).map((gate) => gate.name);
  const after = result.after ? String(cost(result.after)) : "not replayed";
  return (
    `round ${round}: ${result.promoted ? "promoted" : "not promoted"}` +
    `${failed.length ? `, gates failed: ${failed.join(", ")}` : ""}` +
    `, cost ${cost(result.before)} -> ${after}`
  );
}

const pct = (value: number) => `${Math.round(value * 100)}%`;

/** A markdown table of the arms, then one line per improvement round. */
export function formatReport(report: BenchmarkReport): string {
  const rows = report.arms.map(
    (arm) =>
      `| ${arm.label} | ${pct(arm.accuracy)} | ${arm.violations} | ${arm.modelCalls} | ` +
      `${arm.judgeCalls} | ${arm.rejections} |`,
  );
  return [
    "| arm | accuracy | violations | model calls | judge calls | rejections |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    ...rows,
    "",
    ...report.improvements.map((result, index) => `- ${improvementLine(index + 1, result)}`),
  ].join("\n");
}
