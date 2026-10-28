import {
  getInitialMicrosteps,
  getMicrosteps,
  type AnyStateMachine,
  type AnyStateNode,
  type AnyTransitionDefinition,
} from "xstate";
import { isRecord } from "./internal/is-record.js";
import { statePaths, traceSteps, valueOf } from "./internal/trace-states.js";
import { isExplorationComplete, type AgentPathReport } from "./verify.js";

/** One state's row in a {@link CoverageReport}. */
export interface StateCoverage {
  /** The state's dot-joined path from the root, e.g. `'deciding'` or `'work.review'`. */
  state: string;
  /** Runs that were in this state at least once. */
  runs: number;
}

/** A handler: the state node that declares it and its event descriptor. */
export interface HandlerRef {
  /** The declaring state's dot path; `''` for the machine root. */
  state: string;
  /** The descriptor as XState keys it: `'APPROVE'`, `'task.*'`, `'*'`, `'xstate.done.actor'`, `'xstate.error.actor'`, `'xstate.after'`. */
  event: string;
}

/** One handler's row in a {@link CoverageReport}. */
export interface HandlerCoverage extends HandlerRef {
  /** Runs in which this handler was credited at least once. */
  runs: number;
  targets: {
    /** Target state paths of the object transitions under this descriptor; `'dynamic'` when any is a function transition. */
    declared: string[] | "dynamic";
    /** Active leaves observed right after a step credited to this handler. */
    seen: string[];
    /** Declared targets that no seen leaf is in. Empty when `declared` is `'dynamic'`. */
    unreached: string[];
  };
}

/** The result of {@link traceCoverage}. */
export interface CoverageReport {
  /** Every atomic and final state, in document order, including `runs: 0`. */
  states: StateCoverage[];
  /** Every observable handler, in document order, including `runs: 0`. */
  handlers: HandlerCoverage[];
  /** States no run visited, excluding `unreachable` ones. */
  unvisitedStates: string[];
  /** Handlers no run was credited with. */
  unvisitedHandlers: HandlerRef[];
  /** `always` handlers: they fire inside a macrostep, which a trace does not record. */
  unobservable: HandlerRef[];
  /**
   * With a complete `reachable` report: states no explored path reached and
   * no trace visited. They leave the state denominator.
   */
  unreachable?: string[];
  /**
   * With `reachable`: whether the report explored every path. When `false`,
   * a state it missed may still be reachable, so `unreachable` is absent and
   * every state stays in the denominator.
   */
  reachableComplete?: boolean;
  /** Visited over total, for states and for handlers (unobservable excluded). 1 when the total is 0. */
  ratio: { states: number; handlers: number };
}

/** Options for {@link traceCoverage}. */
export interface TraceCoverageOptions {
  /**
   * An `explorePaths` report. When it explored every path (no cap hit, every
   * payload expanded, no branch stopped early), states it never reached drop
   * out of the state denominator.
   */
  reachable?: AgentPathReport;
}

/** Mirrors xstate@6.0.0-alpha.69 `matchesEventDescriptor` (src/utils.ts), which the package does not export. */
function matchesDescriptor(eventType: string, descriptor: string): boolean {
  if (descriptor === eventType || descriptor === "*") return true;
  if (!descriptor.endsWith(".*")) return false;
  const tokens = descriptor.split(".");
  const eventTokens = eventType.split(".");
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index] === "*") return index === tokens.length - 1;
    if (tokens[index] !== eventTokens[index]) return false;
  }
  return true;
}

/** Whether a definition's `matches` pattern (e.g. an invoke's `actorId`) accepts the traced event. */
function matchesPattern(definition: AnyTransitionDefinition, event: unknown): boolean {
  const pattern = (definition as { matches?: unknown }).matches;
  if (!isRecord(pattern) || !isRecord(event)) return true;
  return Object.entries(pattern).every(([key, value]) => Object.is(event[key], value));
}

/**
 * The descriptor XState would try first at `node` for `event`, guards aside:
 * the exact key, then partial and wildcard keys longest first, as in
 * xstate@6.0.0-alpha.69 `getCandidates` (src/stateUtils.ts).
 */
function candidateAt(node: AnyStateNode, type: string, event: unknown): string | undefined {
  const keys = [...node.transitions.keys()]
    .filter((key) => key !== type && matchesDescriptor(type, key))
    .sort((a, b) => b.length - a.length);
  if (node.transitions.has(type)) keys.unshift(type);
  return keys.find((key) => node.transitions.get(key)!.some((d) => matchesPattern(d, event)));
}

const pathOf = (node: AnyStateNode) => node.path.join(".");

const sameLeaves = (a: unknown, b: unknown) =>
  statePaths(a).sort().join("|") === statePaths(b).sort().join("|");

/**
 * The leaves a trace passed through inside its macrosteps: states an `always`
 * transition left before the step ended, which no traced snapshot holds.
 * Re-derived with XState's pure `getMicrosteps` from the snapshot before each
 * step (the previous step's, or the fresh start's microsteps from its input).
 * A step that cannot be recomputed, or whose recomputation ends elsewhere
 * than the traced snapshot, adds none. Only `value` and `context` are rebuilt,
 * so a guard that reads live children can take another route to the same
 * leaves, and that route is credited.
 */
function passedThrough(
  machine: AnyStateMachine,
  trace: readonly Record<string, unknown>[],
): Set<string> {
  const leaves = new Set<string>();
  let resumed = false;
  let previous: Record<string, unknown> | undefined;
  for (const event of trace) {
    if (event.type === "run.start") resumed = event.snapshot !== undefined;
    if (event.type !== "machine.transition" || !isRecord(event.event)) continue;
    const snapshot = isRecord(event.snapshot) ? event.snapshot : undefined;
    try {
      const microsteps =
        event.event.type === "@xstate.init"
          ? resumed
            ? []
            : getInitialMicrosteps(machine, event.event.input as never)
          : previous && sameLeaves(previous.value, valueOf(event.from))
            ? getMicrosteps(
                machine,
                machine.resolveState({ value: previous.value, context: previous.context } as never),
                event.event as never,
              )
            : [];
      // A recomputation that lands somewhere the trace did not (a guard that
      // read live state the snapshot does not hold) took another route.
      const last = microsteps.at(-1)?.[0];
      if (last && snapshot && sameLeaves(last.value, snapshot.value)) {
        for (const [step] of microsteps) {
          for (const leaf of statePaths(step.value)) leaves.add(leaf);
        }
      }
    } catch {
      // Not recomputable from the trace alone.
    }
    previous = snapshot;
  }
  return leaves;
}

const ratioOf = (visited: number, total: number) => (total === 0 ? 1 : visited / total);

/**
 * Measures how much of a machine a set of runs exercised: which atomic and
 * final states they visited, and which handlers they took. A handler is a
 * `(declaring state, event descriptor)` pair from `on`, invoke
 * `onDone`/`onError`, and `after`, with the targets it declares and the
 * leaves the runs landed in after it. Pure; reads only `machine.transition`
 * events, live (`AgentTraceEvent`) or serialized (`serializeTraceEvent`).
 *
 * A step credits one handler per active leaf: the nearest node, from the leaf
 * up, whose exact, partial (`a.*`), or wildcard (`*`) descriptor matches the
 * event, preferred in XState's order. Guards are not replayed, so a step
 * whose nearest handler was rejected and fell through to an ancestor is
 * credited to the nearest one. XState keys invoke and `after` handlers by
 * bare type (`xstate.done.actor`), one per state however many invokes; a
 * definition's `matches` (an invoke's `actorId`) must accept the traced event
 * for its state to be credited. Ignored steps credit no handler. `always`
 * handlers are listed as `unobservable`, never as unvisited; a state one
 * passes through is visited, re-derived from each step's microsteps.
 *
 * @example
 * ```ts no-check
 * const report = traceCoverage(machine, traces, { reachable: await explorePaths(machine) });
 * expect(report.unvisitedHandlers).toEqual([]);
 * ```
 */
export function traceCoverage<TTrace extends readonly { readonly type: string }[]>(
  machine: AnyStateMachine,
  traces: Iterable<TTrace>,
  options: TraceCoverageOptions = {},
): CoverageReport {
  const nodes = new Map<string, AnyStateNode>();
  const states: StateCoverage[] = [];
  const handlers: HandlerCoverage[] = [];
  const handlerAt = new Map<AnyStateNode, Map<string, HandlerCoverage>>();
  const unobservable: HandlerRef[] = [];

  const walk = (node: AnyStateNode): void => {
    const state = pathOf(node);
    nodes.set(state, node);
    if (node.type === "atomic" || node.type === "final") states.push({ state, runs: 0 });
    const byEvent = new Map<string, HandlerCoverage>();
    for (const [event, definitions] of node.transitions) {
      const dynamic = definitions.some((d) => typeof d.to === "function");
      const declared = [...new Set(definitions.flatMap((d) => (d.target ?? []).map(pathOf)))];
      const handler: HandlerCoverage = {
        state,
        event,
        runs: 0,
        targets: { declared: dynamic ? "dynamic" : declared, seen: [], unreached: [] },
      };
      handlers.push(handler);
      byEvent.set(event, handler);
    }
    handlerAt.set(node, byEvent);
    if (node.always?.length) unobservable.push({ state, event: "always" });
    for (const child of Object.values(node.states)) walk(child);
  };
  walk(machine.root);

  const stateRuns = new Map(states.map((row) => [row.state, row]));
  const seen = new Map<HandlerCoverage, Set<string>>();
  for (const trace of traces) {
    const steps = traceSteps(trace);
    // `traceSteps` skips `@xstate.init`; its snapshot is still a visited state.
    const visited = new Set<string>(steps[0]?.from);
    for (const event of trace as readonly Record<string, unknown>[]) {
      if (event.type !== "machine.transition" || !isRecord(event.event)) continue;
      if (event.event.type !== "@xstate.init" || !isRecord(event.snapshot)) continue;
      for (const leaf of statePaths(event.snapshot.value)) visited.add(leaf);
    }
    if (unobservable.length > 0) {
      for (const leaf of passedThrough(machine, trace as readonly Record<string, unknown>[])) {
        visited.add(leaf);
      }
    }
    const credited = new Set<HandlerCoverage>();
    for (const step of steps) {
      for (const leaf of step.to) visited.add(leaf);
      if (step.ignored) continue;
      const hits = new Set<HandlerCoverage>();
      for (const leaf of step.from) {
        // Final states take no transitions; XState asks their ancestors.
        for (let node = nodes.get(leaf); node; node = node.parent) {
          if (node.type === "final") continue;
          const event = candidateAt(node, step.event, step.payload);
          if (event === undefined) continue;
          hits.add(handlerAt.get(node)!.get(event)!);
          break;
        }
      }
      for (const handler of hits) {
        credited.add(handler);
        let leaves = seen.get(handler);
        if (!leaves) seen.set(handler, (leaves = new Set()));
        for (const leaf of step.to) leaves.add(leaf);
      }
    }
    for (const state of visited) {
      const row = stateRuns.get(state);
      if (row) row.runs++;
    }
    for (const handler of credited) handler.runs++;
  }

  for (const handler of handlers) {
    const leaves = [...(seen.get(handler) ?? [])];
    handler.targets.seen = leaves;
    const { declared } = handler.targets;
    if (declared === "dynamic") continue;
    handler.targets.unreached = declared.filter(
      (target) => !leaves.some((leaf) => leaf === target || leaf.startsWith(`${target}.`)),
    );
  }

  // A partial report proves nothing about the states it missed, and a state a
  // trace visited is reachable whatever the report says.
  const reachableComplete = options.reachable
    ? isExplorationComplete(options.reachable)
    : undefined;
  let unreachable: string[] | undefined;
  if (options.reachable && reachableComplete) {
    const reached = new Set(options.reachable.reachedStates.flatMap((value) => statePaths(value)));
    unreachable = states
      .filter((row) => !reached.has(row.state) && row.runs === 0)
      .map((row) => row.state);
  }
  const counted = unreachable ? states.filter((row) => !unreachable.includes(row.state)) : states;
  const unvisitedStates = counted.filter((row) => row.runs === 0).map((row) => row.state);
  const unvisitedHandlers = handlers
    .filter((handler) => handler.runs === 0)
    .map(({ state, event }) => ({ state, event }));

  return {
    states,
    handlers,
    unvisitedStates,
    unvisitedHandlers,
    unobservable,
    ...(unreachable ? { unreachable } : {}),
    ...(reachableComplete === undefined ? {} : { reachableComplete }),
    ratio: {
      states: ratioOf(counted.length - unvisitedStates.length, counted.length),
      handlers: ratioOf(handlers.length - unvisitedHandlers.length, handlers.length),
    },
  };
}
