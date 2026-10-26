import { AgentError } from "./errors.js";

/** One labeled case: what a person said and what the judge said. See {@link judgeAgreement}. */
export interface AgreementRow {
  /** Identifies the case in `disagreements`. */
  id: string;
  /** The confirmed human label. */
  human: string;
  /** The judge's label for the same case. */
  judge: string;
  /** The group the row is aligned in, e.g. a decision state or request name. `groupBy` overrides it. */
  group?: string;
}

/** Agreement numbers for one set of rows. See {@link AgreementReport}. */
export interface AgreementSummary {
  /** Rows counted. */
  total: number;
  /** Share of rows where `judge` equals `human`. */
  accuracy: number;
  /** Per human label: rows with that label, and how many the judge matched. `agreed / human` is that label's recall. */
  perLabel: Record<string, { human: number; agreed: number }>;
  /** Counts by human label, then judge label. */
  confusion: Record<string, Record<string, number>>;
  /** Rows where the judge differs from the person, in input order. */
  disagreements: { id: string; human: string; judge: string }[];
  /**
   * With `positive` set: the true positive rate (judge says positive when the
   * person did) and true negative rate (judge says any other label when the
   * person did). A rate is `undefined` when no row has that human side.
   */
  binary?: { tpr: number | undefined; tnr: number | undefined };
  /**
   * With `positive` set: estimates the true share of positives among
   * unlabeled rows from the share `p` the judge labeled positive,
   * θ = (p + TNR − 1) / (TPR + TNR − 1), clamped to [0, 1]. Omitted when
   * either rate is `undefined`, or when TPR + TNR ≤ 1: the judge is no better
   * than chance, so its labels carry no signal to correct.
   */
  correct?: (observedPositiveRate: number) => number;
}

/** The result of {@link judgeAgreement}. */
export interface AgreementReport extends AgreementSummary {
  /** The same numbers per group. Present when any row has `group` or `groupBy` is given. */
  groups?: Record<string, AgreementSummary>;
}

/** Options for {@link judgeAgreement}. */
export interface JudgeAgreementOptions<TRow extends AgreementRow> {
  /** The positive label. Every other label is negative. Turns on `binary` and `correct`. */
  positive?: string;
  /** The row's group, overriding `row.group`. Return `undefined` to leave the row out of every group. */
  groupBy?: (row: TRow) => string | undefined;
}

/**
 * Measures how well a judge agrees with people on the same cases: accuracy,
 * per-label recall, the confusion matrix, and the rows that disagree. With
 * `positive`, also the TPR and TNR, the recommended view for binary judges
 * (Husain/Shankar), and a correction for the judge's bias on unlabeled rows.
 * Pure.
 *
 * Build rows from confirmed labels only; draft labels gate nothing. Group by
 * decision state or request name so each narrow judge is aligned on its own.
 * A row with no group key counts in the totals and in no group. Run it on a
 * dev split and report the held-out split separately.
 *
 * Throws `AgentError` with code `'empty-agreement-rows'` when `rows` is empty.
 *
 * @example
 * ```ts no-check
 * const report = judgeAgreement(
 *   labeled.map((s) => ({ id: s.id, human: s.label, judge: verdicts[s.id], group: s.request })),
 *   { positive: 'fail' },
 * );
 * report.binary; // { tpr: 0.9, tnr: 0.8 }
 * report.correct?.(0.3); // estimated true failure rate in production
 * ```
 */
export function judgeAgreement<TRow extends AgreementRow>(
  rows: readonly TRow[],
  options: JudgeAgreementOptions<TRow> = {},
): AgreementReport {
  if (rows.length === 0) {
    throw new AgentError(
      "empty-agreement-rows",
      "judgeAgreement: rows must contain at least one row.",
    );
  }
  const report: AgreementReport = summarize(rows, options.positive);
  const groupOf = options.groupBy ?? ((row: TRow) => row.group);
  if (options.groupBy || rows.some((row) => row.group !== undefined)) {
    const grouped = new Map<string, TRow[]>();
    for (const row of rows) {
      const key = groupOf(row);
      if (key === undefined) continue;
      const members = grouped.get(key);
      if (members) members.push(row);
      else grouped.set(key, [row]);
    }
    const groups: Record<string, AgreementSummary> = Object.create(null);
    for (const [key, members] of grouped) groups[key] = summarize(members, options.positive);
    report.groups = groups;
  }
  return report;
}

function summarize(rows: readonly AgreementRow[], positive: string | undefined): AgreementSummary {
  // Null-prototype records, so a label such as `__proto__` is an own key.
  const perLabel: AgreementSummary["perLabel"] = Object.create(null);
  const confusion: AgreementSummary["confusion"] = Object.create(null);
  const disagreements: AgreementSummary["disagreements"] = [];
  let agreed = 0;
  for (const { id, human, judge } of rows) {
    const label = (perLabel[human] ??= { human: 0, agreed: 0 });
    const row = (confusion[human] ??= Object.create(null) as Record<string, number>);
    label.human++;
    row[judge] = (row[judge] ?? 0) + 1;
    if (human === judge) {
      label.agreed++;
      agreed++;
    } else {
      disagreements.push({ id, human, judge });
    }
  }
  const summary: AgreementSummary = {
    total: rows.length,
    accuracy: agreed / rows.length,
    perLabel,
    confusion,
    disagreements,
  };
  if (positive === undefined) return summary;

  let positives = 0;
  let truePositives = 0;
  let negatives = 0;
  let trueNegatives = 0;
  for (const { human, judge } of rows) {
    if (human === positive) {
      positives++;
      if (judge === positive) truePositives++;
    } else {
      negatives++;
      if (judge !== positive) trueNegatives++;
    }
  }
  const tpr = positives === 0 ? undefined : truePositives / positives;
  const tnr = negatives === 0 ? undefined : trueNegatives / negatives;
  summary.binary = { tpr, tnr };
  if (tpr !== undefined && tnr !== undefined && tpr + tnr > 1) {
    summary.correct = (p) => Math.min(1, Math.max(0, (p + tnr - 1) / (tpr + tnr - 1)));
  }
  return summary;
}
