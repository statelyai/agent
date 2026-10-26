import { isRecord } from "./internal/is-record.js";
import { statePaths, traceSteps, type TraceStep } from "./internal/trace-states.js";
import { matchesTrajectory, type TrajectoryItem } from "./trajectory.js";

export type { TraceStep };

/** Options for {@link firstDivergence}. */
export interface FirstDivergenceOptions {
  /**
   * Projects a step to the key two traces are compared by. Default
   * `from|event|to`. Override to leave out what may differ between equivalent
   * runs, such as a parallel region that only logs. Steps are still compared
   * in order. Trace references only.
   */
  key?: (step: TraceStep) => string;
}

/** Where a run first departs from its reference. See {@link firstDivergence}. */
export interface Divergence {
  /** The step's index in the run's steps, or the step count when the run ended early. */
  index: number;
  /** The state the run was in when it departed: the first active leaf before that step. */
  state: string;
  /** The decision request that chose that step's event, when one did. */
  decision?: string;
  /** The run's step. Absent when the run ended early. */
  actual?: TraceStep;
  /** The reference's step, or the expected trajectory item the run never reached. Absent when the run went on past a reference trace. */
  expected?: TraceStep | TrajectoryItem;
}

const defaultKey = (step: TraceStep) => `${step.from.join(",")}|${step.event}|${step.to.join(",")}`;

// An empty reference is a trace with no steps. A trace that ended before its
// first transition still carries `run.*` events, which no trajectory holds.
const isTrace = (items: readonly unknown[]) =>
  items.length === 0 ||
  items.some(
    (item) =>
      isRecord(item) &&
      (item.type === "machine.transition" || item.type === "run.start" || item.type === "run.end"),
  );

/**
 * Finds the first step where a run departs from a reference, so a failure is
 * blamed on the state it started in rather than on every state the run went
 * through afterwards.
 *
 * - Against a reference **trace**, such as a passing run of the same
 *   scenario, steps are compared in order by `key`. The first step that
 *   differs, or the point where either trace ends early, is the divergence.
 * - Against an expected **trajectory** (`TrajectoryItem[]`, as for
 *   {@link matchesTrajectory}), the run is laid out as its initial state, then
 *   each step's event and new state. The first expected item it never reaches
 *   is the divergence, blamed on the step after the last item it did reach. A
 *   run that goes on past the trajectory has not diverged.
 *
 * An empty reference is a trace with no steps, so any step diverges from it.
 * A trace is one run's events, live or serialized. Steps the machine ignored
 * changed nothing and are left out on both sides. Returns `undefined` when the
 * run does not diverge.
 *
 * @example
 * ```ts no-check
 * const stats = foldTraces(traces, {
 *   failed,
 *   blame: (trace) => firstDivergence(trace, passingRunFor(trace))?.state,
 * });
 * ```
 */
export function firstDivergence(
  actual: readonly { readonly type: string }[],
  reference: readonly { readonly type: string }[] | readonly TrajectoryItem[],
  options: FirstDivergenceOptions = {},
): Divergence | undefined {
  const steps = traceSteps(actual).filter((step) => !step.ignored);
  return isTrace(reference)
    ? againstTrace(
        steps,
        traceSteps(reference as readonly { readonly type: string }[]).filter(
          (step) => !step.ignored,
        ),
        options.key ?? defaultKey,
      )
    : againstTrajectory(actual, steps, reference as readonly TrajectoryItem[]);
}

function diverged(
  steps: readonly TraceStep[],
  index: number,
  expected?: TraceStep | TrajectoryItem,
  initial: unknown = steps[0]?.fromValue,
): Divergence {
  const step = steps[index];
  // A run that ended early departed from wherever it stopped.
  const state = step ? step.from[0] : (steps.at(-1)?.to[0] ?? statePaths(initial)[0]);
  return {
    index,
    state: state ?? "",
    ...(step?.decision === undefined ? {} : { decision: step.decision }),
    ...(step ? { actual: step } : {}),
    ...(expected === undefined ? {} : { expected }),
  };
}

function againstTrace(
  steps: readonly TraceStep[],
  reference: readonly TraceStep[],
  key: (step: TraceStep) => string,
): Divergence | undefined {
  const length = Math.max(steps.length, reference.length);
  for (let index = 0; index < length; index++) {
    const step = steps[index];
    const want = reference[index];
    if (step && want && key(step) === key(want)) continue;
    // A run with no steps departed from where the reference started.
    return diverged(steps, index, want, steps[0]?.fromValue ?? reference[0]?.fromValue);
  }
  return undefined;
}

function againstTrajectory(
  trace: readonly { readonly type: string }[],
  steps: readonly TraceStep[],
  expected: readonly TrajectoryItem[],
): Divergence | undefined {
  // The run as one timeline: its initial state, then each step's event and the
  // state it led to. A step that left the state unchanged adds only its event,
  // so a state-only trajectory is not tripped by targetless transitions.
  const initial = initialValue(trace, steps);
  const timeline: unknown[] = initial === undefined ? [] : [{ value: initial }];
  const stepAt: number[] = initial === undefined ? [] : [0];
  steps.forEach((step, index) => {
    timeline.push(step.payload);
    stepAt.push(index);
    if (JSON.stringify(step.toValue) !== JSON.stringify(step.fromValue)) {
      timeline.push({ value: step.toValue });
      stepAt.push(index);
    }
  });

  const match = matchesTrajectory(timeline, expected);
  if (!match.firstMiss) return undefined;
  // The search for the missing item started right after the last item the run
  // reached; the step that produced the next timeline entry is where it left.
  const at = match.firstMiss.searchedFrom;
  const index = at < timeline.length ? (stepAt[at] ?? steps.length) : steps.length;
  return diverged(steps, index, match.firstMiss.expected, initial);
}

function initialValue(trace: readonly { readonly type: string }[], steps: readonly TraceStep[]) {
  for (const event of trace as readonly Record<string, unknown>[]) {
    if (event.type === "machine.transition" && isRecord(event.snapshot)) {
      return event.snapshot.value;
    }
  }
  return steps[0]?.fromValue;
}
