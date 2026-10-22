import { isRecord } from "./internal/is-record.js";

/** One run of one scenario, reduced to what parity compares. See {@link compareRuns}. */
export interface ParityRun {
  /** How the run ended: a final state name, or the label of the loop's return. `'threw'` marks a run that threw. */
  outcome: string;
  /** What the run changed in the world, compared structurally. Sort lists whose order does not matter. */
  effects?: unknown;
  /** The rules the run broke, from ground truth. Any entry marks the run as rule-breaking. */
  violations?: readonly unknown[];
  /** Anything else to keep in the report. Not compared. */
  detail?: unknown;
}

/**
 * How one scenario's candidate run relates to its baseline run.
 *
 * - `same`: same outcome, same effects, and neither run broke a rule.
 * - `intended`: the candidate broke no rule, and the baseline broke one (even
 *   with the same outcome and effects), or the baseline missed the scenario's
 *   `expected` outcome that the candidate reached.
 * - `regression`: the candidate broke a rule, or they differ for any other reason.
 */
export type ParityLabel = "same" | "intended" | "regression";

/** One scenario's row in a {@link ParityReport}. */
export interface ParityResult<TScenario> {
  id: string;
  scenario: TScenario;
  label: ParityLabel;
  /** Why the label was given, in a few words. Empty for `same`. */
  reason: string;
  baseline: ParityRun;
  candidate: ParityRun;
}

/** The result of {@link compareRuns}. */
export interface ParityReport<TScenario> {
  scenarios: ParityResult<TScenario>[];
  counts: Record<ParityLabel, number>;
  /** True when no scenario is a `regression`. */
  ok: boolean;
}

/** Options for {@link compareRuns}. */
export interface CompareRunsOptions<TScenario extends { id: string; expected?: string }> {
  scenarios: readonly TScenario[];
  /** Runs the existing implementation (the loop) on one scenario. */
  baseline: (scenario: TScenario) => Promise<ParityRun>;
  /** Runs the replacement (the machine) on one scenario. */
  candidate: (scenario: TScenario) => Promise<ParityRun>;
}

/**
 * Runs every scenario through a baseline and a candidate implementation and
 * labels each difference, so a port can show where it behaves like the code it
 * replaces and where it differs on purpose.
 *
 * Parity is outcome-level: the terminal outcome and the effects in the world,
 * not the sequence of tool calls, since a machine usually reorders steps. A
 * candidate that broke no rule where the baseline broke one is intended, even
 * when the outcome matches. A difference also counts as intended when only the
 * candidate reached the scenario's `expected` outcome. Every other difference,
 * and every candidate rule break, is a regression for a person to review.
 *
 * Runs are sequential, baseline first. A run that throws is recorded with
 * outcome `'threw'` and the error message as its `detail`. Parity holds for
 * these scenarios and these runs only; with a live model, run it more than once.
 *
 * @example
 * ```ts no-check
 * const report = await compareRuns({
 *   scenarios,
 *   baseline: async (s) => toParityRun(await runRawLoop(s)),
 *   candidate: async (s) => toParityRun(await runDesk(s)),
 * });
 * expect(report.ok).toBe(true);
 * ```
 */
export async function compareRuns<TScenario extends { id: string; expected?: string }>(
  options: CompareRunsOptions<TScenario>,
): Promise<ParityReport<TScenario>> {
  const scenarios: ParityResult<TScenario>[] = [];
  const counts: Record<ParityLabel, number> = { same: 0, intended: 0, regression: 0 };
  for (const scenario of options.scenarios) {
    const baseline = await settle(() => options.baseline(scenario));
    const candidate = await settle(() => options.candidate(scenario));
    const { label, reason } = labelRun(scenario.expected, baseline, candidate);
    counts[label]++;
    scenarios.push({ id: scenario.id, scenario, label, reason, baseline, candidate });
  }
  return { scenarios, counts, ok: counts.regression === 0 };
}

async function settle(run: () => Promise<ParityRun>): Promise<ParityRun> {
  try {
    return await run();
  } catch (error) {
    return { outcome: "threw", detail: error instanceof Error ? error.message : String(error) };
  }
}

function labelRun(
  expected: string | undefined,
  baseline: ParityRun,
  candidate: ParityRun,
): { label: ParityLabel; reason: string } {
  if (candidate.violations?.length) {
    return { label: "regression", reason: `candidate broke a rule: ${list(candidate.violations)}` };
  }
  if (candidate.outcome === "threw") {
    return { label: "regression", reason: `candidate threw: ${String(candidate.detail)}` };
  }
  if (baseline.violations?.length) {
    return { label: "intended", reason: `baseline broke a rule: ${list(baseline.violations)}` };
  }
  const sameOutcome = baseline.outcome === candidate.outcome;
  if (sameOutcome && structurallyEqual(baseline.effects, candidate.effects)) {
    return { label: "same", reason: "" };
  }
  if (expected !== undefined && candidate.outcome === expected && baseline.outcome !== expected) {
    return { label: "intended", reason: `only the candidate reached the expected '${expected}'` };
  }
  return {
    label: "regression",
    reason: sameOutcome
      ? "effects differ"
      : `outcome differs: ${baseline.outcome} → ${candidate.outcome}`,
  };
}

function list(items: readonly unknown[]): string {
  return items.map((item) => (typeof item === "string" ? item : JSON.stringify(item))).join(", ");
}

function structurallyEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => structurallyEqual(item, b[index]))
    );
  }
  if (!isRecord(a) || !isRecord(b)) return false;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.hasOwn(b, key) && structurallyEqual(a[key], b[key]))
  );
}
