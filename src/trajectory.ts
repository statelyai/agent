/**
 * Trajectory matching — the `expect` vocabulary for machine agents.
 *
 * A run leaves two trajectories behind: the state path (from `onTransition`)
 * and the durable event log (`result.events`). {@link matchesTrajectory} scores
 * either one against an expected sequence, as an ordered subsequence by default
 * so an extra retry loop does not fail a run that reached the right places in
 * the right order.
 *
 * Dependency-free and keyless, like the rest of the verification family: it is
 * a pure function over values a run already returns.
 *
 * @module
 */
import type { StateValue } from "xstate";
import type { AgentLogEntry } from "./event-log-store.js";

/** An event-shaped trajectory item: anything with a string `type`. */
export interface TrajectoryEvent {
  type: string;
  [key: string]: unknown;
}

/**
 * One item in a trajectory, on either side of the comparison:
 *
 * - a state value — `'drafting'`, a dot path `'review.editing'`, or the nested
 *   object XState reports (`{ review: 'editing' }`),
 * - an event — an {@link AgentLogEntry} from `result.events`, a bare event
 *   object, or just the event type as a string,
 * - a machine snapshot, whose `value` is used.
 */
export type TrajectoryItem = StateValue | AgentLogEntry | TrajectoryEvent | { value: StateValue };

/** Options for {@link matchesTrajectory}. */
export interface MatchTrajectoryOptions {
  /**
   * Require the trajectories to be equal: same length, item for item. Default
   * `false` — expected items must appear in `actual` in order, gaps allowed.
   */
  exact?: boolean;
}

/** The first expected item that could not be found. */
export interface TrajectoryMiss {
  /** Its position in `expected`. */
  index: number;
  /** The expected item itself. */
  expected: TrajectoryItem;
  /** Where the search for it started in `actual` (everything before was already consumed). */
  searchedFrom: number;
}

/**
 * The result of {@link matchesTrajectory}: a boolean for tests, plus enough
 * detail for a scorer's partial credit and a failure message's diagnosis.
 */
export interface TrajectoryMatch {
  /** Every expected item was found, in order (and, in `exact` mode, nothing else). */
  matched: boolean;
  /** How many expected items were matched before the first miss. */
  matchedCount: number;
  /** `expected.length`, so a scorer can compute its own ratio. */
  expectedCount: number;
  /** Partial credit, 0..1. `1` for an empty expectation. */
  score: number;
  /** Absent when `matched`. */
  firstMiss?: TrajectoryMiss;
}

// ─── Normalization ───

type Normalized = { kind: "event"; event: TrajectoryEvent } | { kind: "state"; value: StateValue };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Classifies one item. Event-shaped things (log entries, events) become events;
 * everything else is a state value. A snapshot is unwrapped to its `value`.
 * @internal
 */
function normalize(item: unknown): Normalized {
  if (isRecord(item)) {
    const nested = item["event"];
    if (isRecord(nested) && typeof nested["type"] === "string") {
      return { kind: "event", event: nested as TrajectoryEvent };
    }
    if (typeof item["type"] === "string") {
      return { kind: "event", event: item as TrajectoryEvent };
    }
    if ("value" in item && "status" in item) {
      return { kind: "state", value: item["value"] as StateValue };
    }
  }
  return { kind: "state", value: item as StateValue };
}

/** Every leaf of a state value as a dot path (`{ review: 'editing' }` → `review.editing`). @internal */
function statePaths(value: StateValue): string[] {
  if (typeof value === "string") return [value];
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([key, child]) =>
    statePaths(child as StateValue).map((path) => `${key}.${path}`),
  );
}

/**
 * A string expectation matches a state value when it names one of its leaves or
 * an ancestor of one, so `'review'` matches `{ review: 'editing' }`. @internal
 */
function stateMatchesPath(path: string, value: StateValue): boolean {
  return statePaths(value).some((leaf) => leaf === path || leaf.startsWith(`${path}.`));
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => deepEqual(item, b[index]))
    );
  }
  if (!isRecord(a) || !isRecord(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => deepEqual(a[key], b[key]));
}

/**
 * Does one actual item satisfy one expected item?
 *
 * - A string expectation matches an event's `type`, or a state value it names.
 * - An event expectation matches an event with the same `type` whose other
 *   declared keys deep-equal, so payload details are opt-in.
 * - A state-value expectation matches structurally.
 * @internal
 */
function matchesItem(expected: unknown, actual: unknown): boolean {
  const actualItem = normalize(actual);

  if (typeof expected === "string") {
    return actualItem.kind === "event"
      ? actualItem.event.type === expected
      : stateMatchesPath(expected, actualItem.value);
  }

  const expectedItem = normalize(expected);
  if (expectedItem.kind !== actualItem.kind) return false;
  if (expectedItem.kind === "event" && actualItem.kind === "event") {
    return Object.keys(expectedItem.event).every((key) =>
      deepEqual(expectedItem.event[key], actualItem.event[key]),
    );
  }
  return deepEqual(
    (expectedItem as { value: StateValue }).value,
    (actualItem as { value: StateValue }).value,
  );
}

// ─── The matcher ───

/**
 * Matches a run's trajectory against an expected one.
 *
 * Both trajectories may be state values (collected from `onTransition`) or
 * events (`result.events`, whose {@link AgentLogEntry} envelopes are unwrapped);
 * items are compared by shape, so `['prompting', 'drafting']` scores a state
 * path and `['PROMPT_SUBMITTED', 'SEND']` scores an event log with the same
 * call.
 *
 * Semantics are an ordered subsequence: every expected item must appear in
 * `actual`, in order, with gaps allowed. Pass `{ exact: true }` to require
 * equality instead.
 *
 * @example Trajectory assertions in a test
 * ```ts
 * const statePath: unknown[] = [];
 * const result = await runAgent(machine, {
 *   input,
 *   executors,
 *   onTransition: (snapshot) => statePath.push(snapshot.value),
 * });
 *
 * const path = matchesTrajectory(statePath, ['prompting', 'drafting', 'sent']);
 * expect(path.matched, JSON.stringify(path.firstMiss)).toBe(true);
 * expect(matchesTrajectory(result.events, ['PROMPT_SUBMITTED', 'SEND']).matched).toBe(true);
 * ```
 *
 * @example Partial credit in an eval scorer
 * ```ts
 * const match = matchesTrajectory(output.statePath, expected.statePath);
 * return { name: 'state_path', score: match.score, metadata: { ...match.firstMiss } };
 * ```
 */
export function matchesTrajectory(
  // `actual` comes off a run, where a state path is often collected as
  // `unknown[]` or a snapshot union; matching is by runtime shape, so it is
  // accepted as-is. `expected` is authored, and typed for the help.
  actual: readonly unknown[],
  expected: readonly TrajectoryItem[],
  options: MatchTrajectoryOptions = {},
): TrajectoryMatch {
  const expectedCount = expected.length;

  if (options.exact) {
    let matchedCount = 0;
    let firstMiss: TrajectoryMiss | undefined;
    for (let index = 0; index < expectedCount; index++) {
      if (index < actual.length && matchesItem(expected[index], actual[index])) {
        matchedCount++;
        continue;
      }
      firstMiss = { index, expected: expected[index]!, searchedFrom: index };
      break;
    }
    const matched = !firstMiss && actual.length === expectedCount;
    const denominator = Math.max(expectedCount, actual.length);
    return {
      matched,
      matchedCount,
      expectedCount,
      score: matched ? 1 : denominator === 0 ? 1 : matchedCount / denominator,
      ...(firstMiss ? { firstMiss } : {}),
    };
  }

  let cursor = 0;
  let matchedCount = 0;
  for (let index = 0; index < expectedCount; index++) {
    const want = expected[index]!;
    let found = -1;
    for (let at = cursor; at < actual.length; at++) {
      if (matchesItem(want, actual[at])) {
        found = at;
        break;
      }
    }
    if (found === -1) {
      return {
        matched: false,
        matchedCount,
        expectedCount,
        score: matchedCount / expectedCount,
        firstMiss: { index, expected: want, searchedFrom: cursor },
      };
    }
    matchedCount++;
    cursor = found + 1;
  }

  return {
    matched: true,
    matchedCount,
    expectedCount,
    score: 1,
  };
}
