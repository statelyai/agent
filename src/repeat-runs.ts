import { AgentError } from "./errors.js";
import { firstDivergence } from "./first-divergence.js";
import { traceSteps } from "./internal/trace-states.js";

type AnyTrace = readonly { readonly type: string }[];

/** One run of a repeated scenario. See {@link summarizeRepeats}. */
export interface RepeatRun<TTrace extends AnyTrace = AnyTrace> {
  passed: boolean;
  /** The run's trace. Absent for a run that threw. */
  trace?: TTrace;
  /** How the run ended, for the report. Not compared. */
  outcome?: string;
  /** The message of a run that threw. */
  error?: string;
}

/** One scenario's runs. See {@link summarizeRepeats}. */
export interface RepeatGroup<TScenario, TTrace extends AnyTrace = AnyTrace> {
  id: string;
  scenario: TScenario;
  runs: readonly RepeatRun<TTrace>[];
}

/** One scenario's row in a {@link RepeatReport}. */
export interface RepeatResult<TScenario, TTrace extends AnyTrace = AnyTrace> extends RepeatGroup<
  TScenario,
  TTrace
> {
  /** Runs that passed. */
  passes: number;
  /** At least one run passed: pass@k for this scenario. */
  passAny: boolean;
  /** Every run passed: pass^k for this scenario. */
  passAll: boolean;
  /** Distinct state paths the traced runs took. 1 when every run went the same way. */
  distinctPaths: number;
  /** The state where the runs first went different ways, judged against the first traced run. */
  divergedAt?: string;
}

/** The result of {@link summarizeRepeats} and {@link repeatRuns}. */
export interface RepeatReport<TScenario, TTrace extends AnyTrace = AnyTrace> {
  scenarios: RepeatResult<TScenario, TTrace>[];
  /**
   * The suite's pass^j: the chance that `j` runs of a scenario, drawn from the
   * ones recorded, all pass, averaged over scenarios. The unbiased estimate is
   * C(passes, j) / C(runs, j) per scenario. Scenarios with fewer than `j` runs
   * are left out. Throws when `j` is not a whole number from 1 to the most
   * runs any scenario has.
   */
  passHat: (j: number) => number;
  /** Every recorded trace, ready for `foldTraces` or `traceCoverage`. */
  traces: TTrace[];
}

/** Options for {@link repeatRuns}. */
export interface RepeatRunsOptions<TScenario extends { id: string }, TTrace extends AnyTrace> {
  scenarios: readonly TScenario[];
  /** Runs per scenario. */
  k: number;
  /** Runs one scenario once and returns its trace. `attempt` counts from 0. */
  run: (scenario: TScenario, attempt: number) => Promise<{ trace: TTrace; outcome?: string }>;
  /** Whether a run passed, judged from its ground truth. */
  passed: (scenario: TScenario, result: { trace: TTrace; outcome?: string }) => boolean;
}

/**
 * Summarizes repeated runs of each scenario: how often each passed, whether
 * all its runs passed (pass^k), how many distinct state paths they took, and
 * where they first went different ways. Pure. Use it for runs collected
 * elsewhere, such as CI shards or replays; {@link repeatRuns} collects them and
 * calls it.
 *
 * A scenario that passes 3 of 5 runs and `divergedAt: 'deciding'` points at one
 * decision, not at a flaky agent.
 *
 * @example
 * ```ts no-check
 * const report = summarizeRepeats(shards.map((s) => ({ id: s.id, scenario: s, runs: s.runs })));
 * report.passHat(3); // the chance 3 runs of a scenario all pass
 * ```
 */
export function summarizeRepeats<TScenario, TTrace extends AnyTrace = AnyTrace>(
  groups: readonly RepeatGroup<TScenario, TTrace>[],
): RepeatReport<TScenario, TTrace> {
  const scenarios = groups.map((group) => summarize(group));
  const traces = groups.flatMap((group) =>
    group.runs.flatMap((run) => (run.trace ? [run.trace] : [])),
  );
  const most = Math.max(0, ...groups.map((group) => group.runs.length));
  const passHat = (j: number): number => {
    if (!Number.isInteger(j) || j < 1 || j > most) {
      throw new AgentError(
        "pass-hat-out-of-range",
        `passHat: j must be a whole number from 1 to ${most}, got ${j}.`,
      );
    }
    const eligible = scenarios.filter((scenario) => scenario.runs.length >= j);
    const sum = eligible.reduce(
      (total, scenario) => total + allPass(scenario.passes, scenario.runs.length, j),
      0,
    );
    return sum / eligible.length;
  };
  return { scenarios, passHat, traces };
}

/**
 * Runs every scenario `k` times and summarizes the runs with
 * {@link summarizeRepeats}. Runs are sequential, scenario by scenario. A run
 * that throws fails, with its message as `error` and no trace.
 *
 * With a live model, one run per scenario says little: τ-bench found pass^k
 * falls well below the single-run rate. Report pass^k next to it.
 *
 * @example
 * ```ts no-check
 * const report = await repeatRuns({
 *   scenarios,
 *   k: 5,
 *   run: async (scenario) => {
 *     const trace: AgentTraceEvent[] = [];
 *     const result = await runToQuiescence(
 *       createAgentRuntime(machine, { executors, onTrace: (event) => trace.push(event) }),
 *       { input: scenario.input },
 *     );
 *     return { trace, outcome: String(result.snapshot.value) };
 *   },
 *   passed: (scenario, { outcome }) => outcome === scenario.expected,
 * });
 * report.passHat(5);
 * ```
 */
export async function repeatRuns<TScenario extends { id: string }, TTrace extends AnyTrace>(
  options: RepeatRunsOptions<TScenario, TTrace>,
): Promise<RepeatReport<TScenario, TTrace>> {
  if (!Number.isInteger(options.k) || options.k < 1) {
    throw new AgentError(
      "invalid-repeat-count",
      `repeatRuns: k must be a whole number of 1 or more, got ${options.k}.`,
    );
  }
  const groups: RepeatGroup<TScenario, TTrace>[] = [];
  for (const scenario of options.scenarios) {
    const runs: RepeatRun<TTrace>[] = [];
    for (let attempt = 0; attempt < options.k; attempt++) {
      try {
        const result = await options.run(scenario, attempt);
        runs.push({
          passed: options.passed(scenario, result),
          trace: result.trace,
          ...(result.outcome === undefined ? {} : { outcome: result.outcome }),
        });
      } catch (error) {
        runs.push({ passed: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
    groups.push({ id: scenario.id, scenario, runs });
  }
  return summarizeRepeats(groups);
}

function summarize<TScenario, TTrace extends AnyTrace>(
  group: RepeatGroup<TScenario, TTrace>,
): RepeatResult<TScenario, TTrace> {
  const passes = group.runs.filter((run) => run.passed).length;
  const traces = group.runs.flatMap((run) => (run.trace ? [run.trace] : []));
  const paths = new Set(
    traces.map((trace) =>
      traceSteps(trace)
        .filter((step) => !step.ignored)
        .map((step) => `${step.from.join(",")}|${step.event}|${step.to.join(",")}`)
        .join(" "),
    ),
  );
  // The earliest step any run leaves the first run's path at.
  let earliest: { index: number; state: string } | undefined;
  for (const trace of traces.slice(1)) {
    const divergence = firstDivergence(trace, traces[0]!);
    if (divergence && (!earliest || divergence.index < earliest.index)) earliest = divergence;
  }
  return {
    ...group,
    passes,
    passAny: passes > 0,
    passAll: group.runs.length > 0 && passes === group.runs.length,
    distinctPaths: paths.size,
    ...(earliest ? { divergedAt: earliest.state } : {}),
  };
}

/** C(passes, j) / C(runs, j), as a product so large counts don't overflow. */
function allPass(passes: number, runs: number, j: number): number {
  let chance = 1;
  for (let i = 0; i < j; i++) chance *= Math.max(0, passes - i) / (runs - i);
  return chance;
}
