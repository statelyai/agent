import { isRecord } from "./is-record.js";

/** The `value` of a trace event's `from` or `snapshot`. @internal */
export function valueOf(holder: unknown): unknown {
  return isRecord(holder) ? holder.value : undefined;
}

/** A decision request on its first attempt (no failed attempts yet). @internal */
export function isFirstDecision(request: unknown): request is Record<string, unknown> {
  return (
    isRecord(request) &&
    request.kind === "decision" &&
    (!Array.isArray(request.attempts) || request.attempts.length === 0)
  );
}

/**
 * Every active leaf of a state value as a dot path:
 * `'a'` → `['a']`; `{ a: 'b' }` → `['a.b']`; `{ p: { x: 'one', y: {} } }` → `['p.x.one', 'p.y']`.
 * @internal
 */
export function statePaths(value: unknown, prefix = ""): string[] {
  if (typeof value === "string") return [prefix + value];
  if (!isRecord(value)) return [];
  const entries = Object.entries(value);
  if (entries.length === 0) return prefix ? [prefix.slice(0, -1)] : [];
  return entries.flatMap(([key, child]) => statePaths(child, `${prefix}${key}.`));
}

/** One macrostep read from a trace: a `machine.transition` event. */
export interface TraceStep {
  /** Active leaves before the step. */
  from: string[];
  /** The state value before the step, as traced. */
  fromValue: unknown;
  /** The event's `type`. */
  event: string;
  /** The event object, as traced. */
  payload: unknown;
  /** Active leaves after the step. */
  to: string[];
  /** The state value after the step, as traced. */
  toValue: unknown;
  /** The state had no transition for a host event, so nothing changed. */
  ignored: boolean;
  /** The `name` of the first-attempt decision request that started since the previous step. */
  decision?: string;
}

/**
 * A trace's `machine.transition` events as steps, skipping `@xstate.init`.
 * A first-attempt decision's `request.start` names the decision on the step
 * that follows it. Reads live and serialized traces alike.
 * @internal
 */
export function traceSteps(trace: Iterable<{ readonly type: string }>): TraceStep[] {
  const steps: TraceStep[] = [];
  let decision: string | undefined;
  for (const event of trace as Iterable<Record<string, unknown>>) {
    if (event.type === "request.start" && isFirstDecision(event.request)) {
      const name = event.request.name;
      decision = typeof name === "string" ? name : undefined;
      continue;
    }
    if (event.type !== "machine.transition") continue;
    const type = isRecord(event.event) ? event.event.type : undefined;
    if (type === "@xstate.init") continue;
    const fromValue = valueOf(event.from);
    const toValue = valueOf(event.snapshot);
    steps.push({
      from: statePaths(fromValue),
      fromValue,
      event: typeof type === "string" ? type : "",
      payload: event.event,
      to: statePaths(toValue),
      toValue,
      ignored: event.ignored === true,
      ...(decision === undefined ? {} : { decision }),
    });
    decision = undefined;
  }
  return steps;
}
