import { isRecord } from "./internal/is-record.js";
import { statePaths, valueOf } from "./internal/trace-states.js";

/** A person's verdict as {@link proposeApprovalRules} hands it to `key`. */
export interface ApprovalVerdict<TTrace> {
  /** The approve or reject event, as traced. */
  event: Record<string, unknown>;
  /** The traced snapshot the verdict arrived in: the approval state, with the context that holds the pending call. */
  snapshot: unknown;
  /** The whole run. */
  trace: TTrace;
}

/** Options for {@link proposeApprovalRules}. */
export interface ProposeApprovalRulesOptions<TTrace> {
  /** The state's dot path, such as `'awaitingApproval'`. A verdict counts when the run was in it or in a state inside it. */
  approvalState: string;
  /** Event types that approve, such as `['APPROVE']`. */
  approveEvents: readonly string[];
  /** Event types that reject, such as `['REJECT']`. */
  rejectEvents: readonly string[];
  /**
   * The rule a verdict is evidence for: usually the tool name and a pattern
   * of its arguments, read from `snapshot.context`. `undefined` skips the verdict.
   */
  key: (verdict: ApprovalVerdict<TTrace>) => string | undefined;
  /**
   * The keys a run broke a rule for, from ground truth (a ledger checked
   * after the fact). Any violation blocks `allow` for that key.
   */
  violations?: (trace: TTrace) => Iterable<string>;
}

/** One key's row from {@link proposeApprovalRules}. */
export interface ApprovalRuleProposal {
  key: string;
  /** Approve verdicts, summed over runs. */
  approved: number;
  /** Reject verdicts, summed over runs. */
  rejected: number;
  /** Violations `violations` reported, summed over runs. 0 without `violations`. */
  violations: number;
  /** Indexes, in input order, of the runs with a verdict for this key. */
  runs: number[];
  /**
   * `'allow'`: approved, never rejected, no violation. `'deny'`: rejected,
   * never approved. `null`: mixed evidence.
   */
  proposal: "allow" | "deny" | null;
  /** Runs with a verdict for this key: `runs.length`. */
  support: number;
}

/**
 * Groups the approval verdicts in many runs' traces by `key` and proposes an
 * `allow` or `deny` rule for each. Pure and deterministic; a proposal is for
 * a person to review, and nothing here changes a machine.
 *
 * Reads `machine.transition` events: a verdict is a transition, not ignored,
 * out of `approvalState` on an approve or reject event. Rows come in the
 * order keys were first seen.
 *
 * @example
 * ```ts no-check
 * const rows = proposeApprovalRules(traces, {
 *   approvalState: "awaitingApproval",
 *   approveEvents: ["APPROVE"],
 *   rejectEvents: ["REJECT"],
 *   key: ({ snapshot }) => `${snapshot.context.pending.tool}:${snapshot.context.pending.path}`,
 * });
 * ```
 */
export function proposeApprovalRules<TTrace extends readonly { readonly type: string }[]>(
  traces: Iterable<TTrace>,
  options: ProposeApprovalRulesOptions<TTrace>,
): ApprovalRuleProposal[] {
  const rows = new Map<string, ApprovalRuleProposal>();
  const rowFor = (key: string): ApprovalRuleProposal => {
    let row = rows.get(key);
    if (!row) {
      row = { key, approved: 0, rejected: 0, violations: 0, runs: [], proposal: null, support: 0 };
      rows.set(key, row);
    }
    return row;
  };
  const inState = (value: unknown) =>
    statePaths(value).some(
      (path) => path === options.approvalState || path.startsWith(`${options.approvalState}.`),
    );

  let index = 0;
  for (const trace of traces) {
    const run = index++;
    const seen = new Set<string>();
    let snapshot: unknown;
    for (const event of trace as readonly Record<string, unknown>[]) {
      if (event.type !== "machine.transition") continue;
      const before = snapshot;
      snapshot = event.snapshot;
      const type = isRecord(event.event) ? event.event.type : undefined;
      if (event.ignored === true || typeof type !== "string" || !inState(valueOf(event.from))) {
        continue;
      }
      const approve = options.approveEvents.includes(type);
      if (!approve && !options.rejectEvents.includes(type)) continue;
      const key = options.key({
        event: event.event as Record<string, unknown>,
        snapshot: before,
        trace,
      });
      if (key === undefined) continue;
      const row = rowFor(key);
      if (approve) row.approved++;
      else row.rejected++;
      if (!seen.has(key)) {
        seen.add(key);
        row.runs.push(run);
      }
    }
    for (const key of options.violations?.(trace) ?? []) {
      const row = rows.get(key);
      if (row) row.violations++;
    }
  }

  for (const row of rows.values()) {
    row.support = row.runs.length;
    row.proposal =
      row.approved > 0 && row.rejected === 0 && row.violations === 0
        ? "allow"
        : row.rejected > 0 && row.approved === 0
          ? "deny"
          : null;
  }
  return [...rows.values()];
}

/** One cap for {@link proposeCaps}. Give `failureState` or `failureOutput`. */
export interface CapSpec<TTrace> {
  /** Names the row, such as `'retries'`. */
  name: string;
  /** The cap's value now. A cap runs hit is never proposed below it. */
  current?: number;
  /** The run hit the cap when it entered this state (dot path), such as `'gaveUp'`. */
  failureState?: string;
  /** The run hit the cap when its `run.end` output satisfies this. */
  failureOutput?: (output: unknown) => boolean;
  /** How much of the cap the run used: retries made, steps taken, batch size. `undefined` leaves the run out. */
  valueFromRun: (trace: TTrace) => number | undefined;
}

/** One cap's row from {@link proposeCaps}. */
export interface CapProposal {
  name: string;
  /** Runs that hit the cap. */
  hits: number;
  /** Runs that did not, with a value. */
  passing: number;
  /** The largest value over all runs; `null` with none. */
  max: number | null;
  /** The 95th percentile (nearest rank) over passing runs; `null` with none. */
  p95: number | null;
  /** `p95 + 1`, and never below `current` when any run hit the cap; `null` with no passing run. */
  proposal: number | null;
}

/** Options for {@link proposeCaps}. */
export interface ProposeCapsOptions<TTrace> {
  caps: readonly CapSpec<TTrace>[];
}

/**
 * Proposes a value for each cap (retry count, steps, batch size) from many
 * runs' traces: the 95th percentile of what passing runs used, plus one, and
 * never below the current cap while runs still hit it. Pure and
 * deterministic; a proposal is for a person to review, and nothing here
 * changes a machine.
 *
 * @example
 * ```ts no-check
 * const [retries] = proposeCaps(traces, {
 *   caps: [{ name: "retries", current: 3, failureState: "gaveUp", valueFromRun: countRetries }],
 * });
 * ```
 */
export function proposeCaps<TTrace extends readonly { readonly type: string }[]>(
  traces: Iterable<TTrace>,
  options: ProposeCapsOptions<TTrace>,
): CapProposal[] {
  const runs = [...traces];
  return options.caps.map((cap) => {
    let hits = 0;
    let max: number | null = null;
    const passing: number[] = [];
    for (const trace of runs) {
      const hit = hitCap(trace, cap);
      if (hit) hits++;
      const value = cap.valueFromRun(trace);
      if (value === undefined) continue;
      max = max === null ? value : Math.max(max, value);
      if (!hit) passing.push(value);
    }
    passing.sort((a, b) => a - b);
    const p95 = passing.length ? passing[Math.ceil(0.95 * passing.length) - 1]! : null;
    const proposal =
      p95 === null
        ? null
        : hits > 0 && cap.current !== undefined
          ? Math.max(p95 + 1, cap.current)
          : p95 + 1;
    return { name: cap.name, hits, passing: passing.length, max, p95, proposal };
  });
}

function hitCap<TTrace extends readonly { readonly type: string }[]>(
  trace: TTrace,
  cap: CapSpec<TTrace>,
): boolean {
  for (const event of trace as readonly Record<string, unknown>[]) {
    if (
      cap.failureState !== undefined &&
      event.type === "machine.transition" &&
      statePaths(valueOf(event.snapshot)).some(
        (path) => path === cap.failureState || path.startsWith(`${cap.failureState}.`),
      )
    ) {
      return true;
    }
    if (cap.failureOutput && event.type === "run.end" && event.status === "done") {
      if (cap.failureOutput(event.output)) return true;
    }
  }
  return false;
}
