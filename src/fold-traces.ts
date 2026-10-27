import { isFirstDecision, statePaths, valueOf } from "./internal/trace-states.js";

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
  /** Events this state ignored (`machine.transition` with `ignored`), summed over runs. */
  ignored: number;
  /** Failed runs `blame` attributed to this state. 0 without `blame`. */
  blamed: number;
}

/** Options for {@link foldTraces}. */
export interface FoldTracesOptions<TTrace> {
  /** Whether a run failed, judged from its whole trace. */
  failed: (trace: TTrace) => boolean;
  /**
   * The state a failed run's failure started in, usually
   * `firstDivergence(trace, reference)?.state`. Called for failed runs only;
   * `undefined` blames no state.
   */
  blame?: (trace: TTrace) => string | undefined;
}

/**
 * Folds many runs' traces into per-state stats: how many runs visited each
 * state, how many of those failed, how many options the guards withheld
 * at decisions made there, how many events it ignored, and how many failures
 * `blame` traced back to it. Pure; reads only:
 *
 * - `machine.transition`: the run visited `from.value` and `snapshot.value`;
 *   with `ignored`, each of those states ignored one event.
 * - `request.start` of a decision, first attempt only: its `request.withheld`
 *   counts toward the state the run was in, the `from.value` of the
 *   transition its choice causes.
 *
 * A trace is one run's events, live (`AgentTraceEvent`) or serialized
 * (`serializeTraceEvent`). A host-driven `decideNext` traces nothing; push
 * `{ type: 'request.start', request: result.request }` onto the trace before
 * sending its event. Parallel states count once per active leaf.
 *
 * `failures` counts a failed run against every state it visited, so states
 * after a bad decision rank as high as the decision. Sort by `blamed` to see
 * where failures start.
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
      entry = { state, visits: 0, failures: 0, withheld: 0, ignored: 0, blamed: 0 };
      stats.set(state, entry);
    }
    return entry;
  };

  for (const trace of traces) {
    const visited = new Set<string>();
    let current: string[] = [];
    const visit = (state: string): void => {
      statsFor(state);
      visited.add(state);
    };
    for (const event of trace as readonly Record<string, unknown>[]) {
      if (event.type === "machine.transition") {
        for (const state of statePaths(valueOf(event.from))) visit(state);
        current = statePaths(valueOf(event.snapshot));
        for (const state of current) visit(state);
        if (event.ignored === true) {
          for (const state of current) statsFor(state).ignored++;
        }
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
    const blamed = failed ? options.blame?.(trace) : undefined;
    if (blamed !== undefined) statsFor(blamed).blamed++;
  }
  return [...stats.values()];
}
