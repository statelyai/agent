/**
 * The benchmark: the same seeded match (random, greedy, and perfect X)
 * through every O arm, in order.
 *
 *   M    a raw language model picks every move (`decideNext` closed choice, one `choose_option` tool)
 *   J    a decision model (Jev) picks every move: the player model in the `createAiSdkExecutors` models map
 *   P0   policy v0 (first empty cell)
 *   Pk   the policy after round k of the hill climb, for each promoted round
 *
 * Policy arms also carry the proof verdict and the objective; model arms
 * cannot be proven (a model is not a deterministic program) and show "—".
 * Every arm journals to one event-log store: `<arm>/<opponent>/<game>` for
 * the model arms, `round-<n>/...` for the policies (improve.ts), and
 * `P0/...` for the baseline when no round ran (`rounds: 0`).
 *
 * Run: OPENAI_API_KEY=... pnpm exec tsx examples/tic-tac-toe/benchmark.ts
 *      (add TYPESAFE_AI_API_KEY=... for the Jev arm)
 */
import { openai } from "@ai-sdk/openai";
import { typeSafeAi } from "@ai-sdk/typesafe-ai";
import type { Experimental_DecisionModel, LanguageModel } from "ai";
import type {
  AgentDecisionExecutor,
  AgentEventLogStore,
  AgentRequestExecutor,
} from "@statelyai/agent";
import { createAiSdkExecutors } from "@statelyai/agent/ai-sdk";
import { createInMemoryEventLogStore } from "@statelyai/agent/log";
import {
  evaluatePolicy,
  improvePolicy,
  objective,
  type Evaluation,
  type ImprovementResult,
} from "./improve.js";
import type { OpponentName } from "./opponents.js";
import { PLAYER_MODEL, playMatch, type MatchResult } from "./play.js";
import { loadPolicy } from "./policy.js";

/** A decision model object; a string in the models map would be a language model id. */
type Judge = Exclude<Experimental_DecisionModel, string>;

export type ArmRow = {
  label: string;
  match: MatchResult;
  /** Policy arms only. */
  proof?: "proven" | "refuted";
  objective?: number;
};

export type BenchmarkOptions = {
  /** Arm M's decider. Default: `createAiSdkExecutors` over `textModel`. */
  modelDecide?: AgentDecisionExecutor;
  textModel?: LanguageModel;
  /** Arm J's decision model. Omit to skip the arm. */
  judge?: Judge;
  /** Answers `proposePolicy`. Default: `createAiSdkExecutors` over `textModel`. */
  reflection?: { generateText: AgentRequestExecutor };
  /** Hill-climb rounds; stops early at the first round without a promotion. Default 3. */
  rounds?: number;
  store?: AgentEventLogStore;
  log?: (line: string) => void;
};

export type BenchmarkReport = {
  arms: ArmRow[];
  improvement: ImprovementResult;
  store: AgentEventLogStore;
};

const policyRow = (label: string, evaluation: Evaluation, neverLoseRequired: boolean): ArmRow => ({
  label,
  match: evaluation.match,
  proof: evaluation.proof.neverLoses ? "proven" : "refuted",
  objective: objective(evaluation, { neverLoseRequired }),
});

export async function runBenchmark(options: BenchmarkOptions): Promise<BenchmarkReport> {
  const { rounds = 3, log = () => {} } = options;
  const store = options.store ?? createInMemoryEventLogStore();
  // One text model answers every ref: arm M's moves and the reflection.
  const textModel = options.textModel;
  const sdk = textModel ? createAiSdkExecutors({ resolveModel: () => textModel }) : undefined;
  const modelDecide = options.modelDecide ?? sdk?.decide;
  const reflection = options.reflection ?? (sdk ? { generateText: sdk.generateText } : undefined);
  if (!modelDecide || !reflection) {
    throw new Error("runBenchmark: pass textModel, or both modelDecide and reflection.");
  }

  const arms: ArmRow[] = [];
  const record = (row: ArmRow) => {
    arms.push(row);
    log(summaryLine(row));
  };

  record({
    label: "M: raw model",
    match: await playMatch({ label: "M", decide: modelDecide, store, threadPrefix: "M" }),
  });
  if (options.judge) {
    const { decide } = createAiSdkExecutors({ models: { [PLAYER_MODEL]: options.judge } });
    record({
      label: "J: Jev",
      match: await playMatch({ label: "J", decide, store, threadPrefix: "J" }),
    });
  }

  const v0 = loadPolicy("v0");
  const improvement = await improvePolicy({ current: v0, executors: reflection, rounds, store });
  // The baseline arm always shows: round 1 already evaluated v0; with no rounds, evaluate it here.
  const baseline =
    improvement.rounds[0]?.evaluation ?? (await evaluatePolicy(v0, { store, threadPrefix: "P0" }));
  record(policyRow(`P0: ${v0.id ?? "v0"}`, baseline, false));
  let required = baseline.proof.neverLoses;
  for (const round of improvement.rounds) {
    if (!round.promoted || !round.candidate || !round.proposed) continue;
    record(
      policyRow(
        `P${round.round}: ${round.proposed.id ?? "policy"}`,
        round.candidate.evaluation,
        required,
      ),
    );
    required ||= round.candidate.evaluation.proof.neverLoses;
  }
  return { arms, improvement, store };
}

const OPPONENTS: OpponentName[] = ["random", "greedy", "perfect"];
const fmt = (value: number | undefined) =>
  value === undefined ? "—" : Number.isFinite(value) ? value.toFixed(3) : "-inf";
const wdl = (row: ArmRow, opponent: OpponentName) => {
  const t = row.match.byOpponent[opponent];
  return `${t.wins}/${t.draws}/${t.losses}`;
};

function summaryLine(row: ArmRow): string {
  return (
    `${row.label}: ${OPPONENTS.map((o) => `${o} ${wdl(row, o)}`).join(", ")} (W/D/L), ` +
    `proof ${row.proof ?? "—"}, objective ${fmt(row.objective)}`
  );
}

function roundLine(round: ImprovementResult["rounds"][number]): string {
  const failed = round.gates.filter((gate) => !gate.ok).map((gate) => gate.name);
  return (
    `round ${round.round}: ${round.current.id ?? "policy"} (${fmt(round.objective)}) → ` +
    `${round.proposed?.id ?? "no proposal"}${round.candidate ? ` (${fmt(round.candidate.objective)})` : ""}: ` +
    `${round.promoted ? "promoted" : `not promoted${failed.length ? `, failed ${failed.join(", ")}` : ""}`}` +
    `${round.repairs ? `, ${round.repairs} repair(s)` : ""}`
  );
}

/** A markdown table of the arms (W/D/L per opponent), then one line per round. */
export function formatReport(report: Pick<BenchmarkReport, "arms" | "improvement">): string {
  return [
    "| arm | random W/D/L | greedy W/D/L | perfect W/D/L | proof | objective |",
    "| --- | ---: | ---: | ---: | --- | ---: |",
    ...report.arms.map(
      (row) =>
        `| ${row.label} | ${OPPONENTS.map((o) => wdl(row, o)).join(" | ")} | ${row.proof ?? "—"} | ${fmt(row.objective)} |`,
    ),
    "",
    ...report.improvement.rounds.map((round) => `- ${roundLine(round)}`),
  ].join("\n");
}

// Run directly (`tsx benchmark.ts`); skipped when a test imports this module.
if (import.meta.url === new URL(process.argv[1]!, "file:").href) {
  if (!process.env.OPENAI_API_KEY) {
    console.error("Set OPENAI_API_KEY to run the benchmark (and TYPESAFE_AI_API_KEY for Jev).");
    process.exit(1);
  }
  runBenchmark({
    textModel: openai("gpt-5.4-mini"),
    ...(process.env.TYPESAFE_AI_API_KEY ? { judge: typeSafeAi.decisionModel("jev-latest") } : {}),
    log: (line) => console.log(line),
  })
    .then((report) => console.log(`\n${formatReport(report)}`))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
