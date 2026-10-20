import { isRecord } from "./internal/is-record.js";

/** One state's numbers across many runs. See {@link foldTraces}. */
export interface StateStats {
  /** The state's dot-joined path from the root, e.g. `'deciding'` or `'work.review'`. */
  state: string;
  /** Runs that were in this state at least once. */
  visits: number;
  /** Of those runs, the ones `failed` flagged. */
  failures: number;
  /** Options withheld by the guards at decisions made in this state, summed over runs. */
  withheld: number;
}

/** Options for {@link foldTraces}. */
export interface FoldTracesOptions<TTrace> {
  /** Whether a run failed, judged from its whole trace. */
  failed: (trace: TTrace) => boolean;
}

/**
 * Folds many runs' traces into per-state stats: how many runs visited each
 * state, how many of those failed, and how many options the guards withheld
 * at decisions made there. Pure; reads only:
 *
 * - `machine.transition`: the run visited `from.value` and `snapshot.value`.
 * - `request.start` of a decision, first attempt only: its `request.withheld`
 *   counts toward the state the run was in, the `from.value` of the
 *   transition its choice causes.
 *
 * A trace is one run's events, live (`AgentTraceEvent`) or serialized
 * (`serializeTraceEvent`). A host-driven `decideNext` traces nothing; push
 * `{ type: 'request.start', request: result.request }` onto the trace before
 * sending its event. Parallel states count once per active leaf.
 *
 * @example
 * ```ts no-check
 * const stats = foldTraces(traces, {
 *   failed: (trace) => trace.at(-1)?.type === 'run.end' && trace.at(-1).status === 'error',
 * });
 * ```
 */
export function foldTraces<TTrace extends readonly { readonly type: string }[]>(
  traces: Iterable<TTrace>,
  options: FoldTracesOptions<TTrace>,
): StateStats[] {
  const stats = new Map<string, StateStats>();
  const statsFor = (state: string): StateStats => {
    let entry = stats.get(state);
    if (!entry) {
      entry = { state, visits: 0, failures: 0, withheld: 0 };
      stats.set(state, entry);
    }
    return entry;
  };

  for (const trace of traces) {
    const visited = new Set<string>();
    let current: string[] = [];
    for (const event of trace as readonly Record<string, unknown>[]) {
      if (event.type === "machine.transition") {
        for (const state of statePaths(valueOf(event.from))) visited.add(state);
        current = statePaths(valueOf(event.snapshot));
        for (const state of current) visited.add(state);
      } else if (event.type === "request.start" && isFirstDecision(event.request)) {
        const withheld = event.request.withheld;
        if (!Array.isArray(withheld)) continue;
        for (const state of current) statsFor(state).withheld += withheld.length;
      }
    }
    const failed = options.failed(trace);
    for (const state of visited) {
      const entry = statsFor(state);
      entry.visits++;
      if (failed) entry.failures++;
    }
  }
  return [...stats.values()];
}

function valueOf(holder: unknown): unknown {
  return isRecord(holder) ? holder.value : undefined;
}

function isFirstDecision(request: unknown): request is Record<string, unknown> {
  return (
    isRecord(request) &&
    request.kind === "decision" &&
    (!Array.isArray(request.attempts) || request.attempts.length === 0)
  );
}

// `'a'` → `['a']`; `{ a: 'b' }` → `['a.b']`; `{ p: { x: 'one', y: {} } }` → `['p.x.one', 'p.y']`.
function statePaths(value: unknown, prefix = ""): string[] {
  if (typeof value === "string") return [prefix + value];
  if (!isRecord(value)) return [];
  const entries = Object.entries(value);
  if (entries.length === 0) return prefix ? [prefix.slice(0, -1)] : [];
  return entries.flatMap(([key, child]) => statePaths(child, `${prefix}${key}.`));
}
