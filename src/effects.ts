/**
 * The effect/replay path: the library's new append-only-log core. Two
 * primitives sit under every host loop:
 *
 * - {@link getAgentEffects} maps a transition's ordered executable actions
 *   (reconciled with the still-owed effects visible only on the snapshot) into
 *   an ordered {@link AgentEffect} list a host starts at the frontier.
 * - {@link replay} folds a journal of EXTERNAL inputs through xstate's pure
 *   `initialTransition`/`transition` WITHOUT executing anything, returning the
 *   final snapshot plus the effects still owed — crash recovery, fork resume,
 *   and time travel in one function.
 *
 * The journal of external inputs (effect completions with outputs inline, user
 * events, timer firings) is the authoritative artifact; raised/internal events
 * are never journaled (replay re-derives them). A reserved first entry
 * {@link initEntry} carries the machine input so a log is self-contained.
 * @module
 */
import {
  initialTransition,
  transition,
  type AnyActorLogic,
  type AnyMachineSnapshot,
  type AnyStateMachine,
  type EventObject,
  type ExecutableActionObject,
  type SnapshotFrom,
} from "xstate";
import { getAgentRequests, getInvokeEffectMetadata } from "./steps.js";
import { isDecisionLogic, type AgentDecisionRequest } from "./decision.js";
import {
  isTextLogic,
  type AgentCallUsage,
  type AgentRequestMode,
  type AgentTextRequest,
} from "./text-logic.js";
import { getAcceptedEvents } from "./events.js";
import {
  AGENT_EVENT_SCHEMA_VERSION,
  assertAgentLogEntry,
  assertJsonSerializable,
  type AgentLogEntry,
  type AgentLogVerification,
  type JsonValue,
} from "./event-log-store.js";
import { djb2Hex, getMachineStructuralHash } from "./utils.js";
import { AgentError } from "./errors.js";
import {
  getRegisteredAgentExecutionOptions,
  type AgentExecutionOptions,
} from "./internal/registry.js";

/**
 * One thing a host does at the frontier. Effect kinds mirror what a machine
 * can start in a single transition, each carrying everything the host needs to
 * run it and to journal its completion so replay is deterministic:
 *
 * - `text` — a `TextLogic`/`agent.generateText` invoke. Resolve with the model
 *   (`executeAgentRequest`), then journal `toDoneEvent(output)` (or
 *   `toErrorEvent(error)`).
 * - `decision` — an `agent.decide`/`DecisionLogic` invoke. Resolve with
 *   `resolveDecision` and journal the CHOSEN machine event directly (a decision
 *   has no output value of its own; the chosen event advances the machine).
 * - `task` — any other invoke/spawn: a plain host-run task keyed by `src` +
 *   `input`. Run it, then journal `toDoneEvent`/`toErrorEvent`.
 * - `delay` — an `after(...)` timer. Schedule it; when it fires, journal
 *   `event` (a normal external entry).
 * - `execute` — a fire-and-forget action (a custom entry action, `sendTo`,
 *   `cancel`, …). Run `exec()` once at the frontier; NEVER journaled, never
 *   replayed (replay re-derives it).
 */
export type AgentEffect =
  | {
      kind: "text";
      requestId: string;
      request: AgentTextRequest;
      /** `'stream'` when the authored request wants `streamText`; default `'generate'`. */
      mode?: AgentRequestMode;
      toDoneEvent(output: unknown): EventObject;
      toErrorEvent(error: unknown): EventObject;
    }
  | { kind: "decision"; requestId: string; request: AgentDecisionRequest }
  | {
      kind: "task";
      requestId: string;
      id: string;
      src: string;
      input: unknown;
      toDoneEvent(output: unknown): EventObject;
      toErrorEvent(error: unknown): EventObject;
    }
  | {
      kind: "delay";
      requestId: string;
      id: string;
      delayMs: number;
      /** The `{ type: 'xstate.timer', id }` event the host journals when the timer fires. */
      event: EventObject;
    }
  | { kind: "execute"; action: ExecutableActionObject; exec(): void };

/**
 * The reserved journal event type of the {@link initEntry} first entry: it
 * carries the machine `input` so a log replays with no side-channel. Named in
 * the `agent.*` builtin-actor namespace so it never collides with a machine's
 * own event vocabulary. Consumed by {@link replay}; never fed to `transition`.
 */
export const AGENT_INIT_EVENT_TYPE = "@agent.init" as const;

/**
 * The reserved event type `runAgent` delivers to the running machine after
 * every settled model call that reported usage — the one seam that puts a
 * call's tokens in reach of ordinary `context` and guards, so a token budget
 * is a plain machine transition instead of host bookkeeping.
 *
 * Like {@link AGENT_INIT_EVENT_TYPE} it lives in the reserved `@agent.*`
 * namespace: it can never collide with a machine's own vocabulary, and
 * `getAcceptedEvents`/`parseAgentEvent` never offer it — a model can neither
 * be shown it as a decision candidate nor forge one.
 *
 * Delivery is opt-in BY CONSTRUCTION: the event is sent only when the live
 * snapshot can currently take it (i.e. the machine declares an
 * `'@agent.usage'` transition, usually machine-level `on`). A machine without
 * one sees no extra transition, no extra trace event, and no extra log entry.
 * When it IS taken it rides the event log like any other external input, so
 * events-only recovery (`runAgent({ events })`) replays the folded tokens
 * without re-calling a model.
 */
export const AGENT_USAGE_EVENT_TYPE = "@agent.usage" as const;

/**
 * The payload of the reserved {@link AGENT_USAGE_EVENT_TYPE} event: the
 * settled call's normalized usage plus enough attribution to bill it (per
 * model, per request). Every field is JSON-safe, so the event round-trips
 * through the durable event log unchanged.
 *
 * Attribution fields are optional because not every call site has them — a
 * `getRequests` interpret-pass call reports usage with no invoke identity at
 * all, and only text requests carry a registered `name`.
 */
export interface AgentUsageEvent extends EventObject {
  type: typeof AGENT_USAGE_EVENT_TYPE;
  /** The settled call's token usage, as reported by the executor. */
  usage: AgentCallUsage;
  /** Which kind of request reported it. */
  kind?: "text" | "decision";
  /** The reporting request's durable invoke id. */
  id?: string;
  /** The reporting request's invoke `src`. */
  src?: string;
  /** The model ref the request targeted. */
  model?: string;
  /** The reporting text request's registered `name`, when it declared one. */
  name?: string;
}

/** Options controlling the durable envelope created by {@link createReplayEntry}. */
export interface CreateReplayEntryOptions {
  /** Explicit machine version; defaults to the machine's structural hash. */
  machineVersion?: string;
  /** Stable entry id; defaults to `evt_` plus the zero-padded index. */
  id?: string;
  /** RFC 3339 acceptance time; defaults to the current wall clock. */
  recordedAt?: string;
  causationId?: string;
  correlationId?: string;
  metadata?: Record<string, JsonValue>;
  /** Omit hashes when recording only a post-snapshot suffix without its prefix. */
  verification?: boolean;
}

/**
 * Creates a JSON-safe, self-describing entry and records the state/effect
 * hashes produced after replaying it. `entries` must be the complete prefix.
 */
export function createReplayEntry<TMachine extends AnyStateMachine>(
  machine: TMachine,
  entries: readonly AgentLogEntry[],
  event: EventObject,
  options: CreateReplayEntryOptions = {},
): AgentLogEntry {
  const index = entries.length;
  const machineId = (machine.config as { id?: string }).id ?? machine.id ?? "(machine)";
  const machineVersion = options.machineVersion ?? getMachineStructuralHash(machine);
  const entry: AgentLogEntry = {
    schemaVersion: AGENT_EVENT_SCHEMA_VERSION,
    id: options.id ?? `evt_${String(index).padStart(8, "0")}`,
    index,
    recordedAt: options.recordedAt ?? new Date().toISOString(),
    machineId,
    machineVersion,
    event: normalizeEventErrors(event) as EventObject,
    ...(options.causationId !== undefined ? { causationId: options.causationId } : {}),
    ...(options.correlationId !== undefined ? { correlationId: options.correlationId } : {}),
    ...(options.metadata !== undefined ? { metadata: options.metadata } : {}),
  };
  assertAgentLogEntry(entry);
  if (options.verification !== false) {
    const result = replay(machine, [...entries, entry], {
      machineVersion,
      verify: false,
    });
    // The only field attached after validation; its hashes are always
    // non-empty hex, so the envelope stays valid.
    entry.verification = replayVerification(result.snapshot as AnyMachineSnapshot, result.effects);
  }
  return entry;
}

/** Reserved first replay entry carrying machine input and verification hashes. */
export function initEntry<TMachine extends AnyStateMachine>(
  machine: TMachine,
  input?: unknown,
  options: CreateReplayEntryOptions = {},
): AgentLogEntry {
  return createReplayEntry(
    machine,
    [],
    {
      type: AGENT_INIT_EVENT_TYPE,
      ...(input !== undefined ? { input } : {}),
    } as EventObject,
    options,
  );
}

/** Options accepted by {@link getAgentEffects} and {@link replay}. */
export interface GetAgentEffectsOptions extends Partial<AgentExecutionOptions> {
  /**
   * The journal so far — an `EventObject[]` OR an `AgentLogEntry[]` (both
   * accepted). Occurrence counts (the `n` in a `requestId`) are derived from
   * it, so requestIds are stable across replay by construction.
   */
  history?: readonly (EventObject | AgentLogEntry)[];
}

/** Normalizes a mixed `EventObject | AgentLogEntry` history into bare events. */
function toEvents(history: readonly (EventObject | AgentLogEntry)[] | undefined): EventObject[] {
  if (!history) {
    return [];
  }
  return history.map((entry) => {
    const candidate = entry as AgentLogEntry;
    return candidate && typeof candidate === "object" && "event" in candidate && candidate.event
      ? candidate.event
      : (entry as EventObject);
  });
}

function rebindActorSession(
  event: EventObject,
  snapshot: AnyMachineSnapshot,
  sessions: Map<string, string>,
): EventObject {
  const actorEvent = event as EventObject & { actorId?: unknown; sessionId?: unknown };
  if (typeof actorEvent.actorId !== "string" || typeof actorEvent.sessionId !== "string") {
    return event;
  }

  const key = `${actorEvent.actorId}\0${actorEvent.sessionId}`;
  let sessionId = sessions.get(key);
  if (!sessionId) {
    const child = (snapshot.children as Record<string, { sessionId?: unknown }>)[
      actorEvent.actorId
    ];
    if (typeof child?.sessionId !== "string") {
      return event;
    }
    sessionId = child.sessionId;
    sessions.set(key, sessionId);
  }

  return { ...event, sessionId } as EventObject;
}

const DONE_ACTOR_EVENT_TYPE = "xstate.done.actor";
const ERROR_ACTOR_EVENT_TYPE = "xstate.error.actor";

function isInvokeCompletion(event: EventObject, id: string): boolean {
  return (
    (event.type === DONE_ACTOR_EVENT_TYPE || event.type === ERROR_ACTOR_EVENT_TYPE) &&
    (event as EventObject & { actorId?: unknown }).actorId === id
  );
}

/**
 * 1-based occurrence for an invoke/spawn site: `1 + completions` (done AND
 * error both count — an error is a semantic completion) for `id` in `events`.
 */
function invokeOccurrence(events: readonly EventObject[], id: string): number {
  let count = 0;
  for (const event of events) {
    if (isInvokeCompletion(event, id)) {
      count++;
    }
  }
  return count + 1;
}

/** The exact canonical done/error events xstate's actor system delivers for an invoke `id`. */
function invokeEventMinters(
  id: string,
  snapshot: AnyMachineSnapshot,
): {
  toDoneEvent(output: unknown): EventObject;
  toErrorEvent(error: unknown): EventObject;
} {
  const child = (snapshot.children as Record<string, { sessionId?: unknown }>)[id];
  const identity = {
    actorId: id,
    ...(typeof child?.sessionId === "string" ? { sessionId: child.sessionId } : {}),
  };
  return {
    toDoneEvent: (output: unknown) => ({
      type: DONE_ACTOR_EVENT_TYPE,
      output,
      ...identity,
    }),
    toErrorEvent: (error: unknown) => ({
      type: ERROR_ACTOR_EVENT_TYPE,
      error,
      ...identity,
    }),
  };
}

/** Splits an `xstate.after.<delayKey>.<statePath>` id into its parts. */
function parseAfterId(afterId: string): { delayKey: string; statePath: string } | undefined {
  const prefix = "xstate.after.";
  if (!afterId.startsWith(prefix)) {
    return undefined;
  }
  const rest = afterId.slice(prefix.length);
  const dot = rest.indexOf(".");
  if (dot === -1) {
    return undefined;
  }
  return { delayKey: rest.slice(0, dot), statePath: rest.slice(dot + 1) };
}

// The raw executable-action shape this pass reads (a superset of the built-in
// action objects xstate returns; every field optional so the same reader
// handles spawn/raise/sendTo/custom without narrowing per type).
interface RawAction {
  type?: string;
  id?: unknown;
  src?: unknown;
  input?: unknown;
  logic?: unknown;
  event?: EventObject;
  delay?: unknown;
  exec?: (() => void) | undefined;
  params?: unknown;
}

// Builds a text/decision/task effect for one invoke site. Prefers a
// pre-shaped request (from getAgentRequests, which resolves prompts /
// schemas / decision candidate events exactly as the step path does); falls
// back to classifying the logic directly for a snapshot-owed child that no
// action shaped this frontier.
function buildInvokeEffect(
  meta: { id?: unknown; src?: unknown; input?: unknown; logic?: unknown },
  mapped: ReturnType<typeof getAgentRequests>[number] | undefined,
  events: readonly EventObject[],
  snapshot: AnyMachineSnapshot,
  options: AgentExecutionOptions,
): AgentEffect | undefined {
  const id = typeof meta.id === "string" ? meta.id : undefined;
  if (!id) {
    return undefined;
  }
  const requestId = `${id}#${invokeOccurrence(events, id)}`;

  if (mapped?.kind === "text") {
    return {
      kind: "text",
      requestId,
      request: mapped.input,
      mode: mapped.mode,
      ...invokeEventMinters(id, snapshot),
    };
  }
  if (mapped?.kind === "decision") {
    return { kind: "decision", requestId, request: mapped };
  }

  // No pre-shaped request (a dynamic spawn, or a snapshot-owed child) —
  // classify the logic directly.
  const logic =
    isTextLogic(meta.logic) || isDecisionLogic(meta.logic)
      ? meta.logic
      : typeof meta.src === "string"
        ? options.actors?.[meta.src]
        : undefined;

  if (isTextLogic(logic)) {
    const request = logic.request(meta.input as never);
    return {
      kind: "text",
      requestId,
      request,
      mode: logic.mode,
      ...invokeEventMinters(id, snapshot),
    };
  }
  if (isDecisionLogic(logic)) {
    const base = logic.request(meta.input as never);
    const eventTypes = (
      logic as unknown as {
        allowedEventTypes?: (input: unknown) => readonly string[] | undefined;
      }
    ).allowedEventTypes?.(meta.input);
    const candidateEvents = getAcceptedEvents(snapshot, {
      events: options.schemas?.events,
      schemas: options.schemas,
      eventTypes,
    });
    return { kind: "decision", requestId, request: { ...base, id, events: candidateEvents } };
  }

  // Anything else is a plain host-run task.
  const src = typeof meta.src === "string" ? meta.src : id;
  return {
    kind: "task",
    requestId,
    id,
    src,
    input: meta.input,
    ...invokeEventMinters(id, snapshot),
  };
}

/**
 * Maps a transition's ORDERED executable actions (plus the still-owed effects
 * visible only on the snapshot) into an ordered {@link AgentEffect} list the
 * host starts at the frontier.
 *
 * Ordering is load-bearing: a single transition's actions are emitted in
 * document order (a custom entry action, a spawn, and a `sendTo` in that order
 * yield `execute`, then `task`/agent effect, then `execute` — never a
 * reordered set). Effects visible only on the snapshot (children spawned by
 * an EARLIER transition that
 * have not completed yet — the fan-out / crash-resume case) are appended after
 * the action-derived effects, deduped by site id.
 *
 * Every `requestId` is `${siteId}#${n}`, `n` the 1-based occurrence derived
 * from `options.history` — so the same log yields identical requestIds on every
 * replay. XState alpha.24 prunes a child when its matching completion is
 * folded; the history check also prevents older/restored snapshots from
 * re-surfacing completed work. A re-entered invoke site instead re-derives
 * from the action list each fresh entry (so `#2`, `#3`, … stay correct).
 */
export function getAgentEffects(
  machine: AnyActorLogic,
  snapshot: AnyMachineSnapshot,
  actions: readonly ExecutableActionObject[],
  options: GetAgentEffectsOptions = {},
): AgentEffect[] {
  const resolved = getRegisteredAgentExecutionOptions(machine, options);
  const events = toEvents(options.history);
  // The built-in action objects, read through this pass's structural superset.
  const rawActions = actions as unknown as readonly RawAction[];

  // Pre-shape text/decision requests (in action order) exactly as the step
  // path does.
  const requests = getAgentRequests(rawActions, {
    ...resolved,
    snapshot,
  });
  const requestById = new Map(requests.map((request) => [request.id, request]));

  const effects: AgentEffect[] = [];
  const emitted = new Set<string>();

  // 1. Action-derived effects, in document order.
  for (const rawAction of rawActions) {
    const meta = getInvokeEffectMetadata(rawAction);
    if (meta) {
      const effect = buildInvokeEffect(
        meta,
        typeof meta.id === "string" ? requestById.get(meta.id) : undefined,
        events,
        snapshot,
        resolved,
      );
      if (effect && typeof meta.id === "string") {
        effects.push(effect);
        emitted.add(meta.id);
      }
      continue;
    }

    // A DELAYED raise is an `after(...)` timer. An immediate raise never
    // surfaces here — xstate processes it inside `transition` (replay
    // re-derives it), which is exactly why raised events are not journaled.
    if (rawAction.type === "@xstate.raise" && typeof rawAction.delay === "number") {
      const afterId = typeof rawAction.id === "string" ? rawAction.id : "";
      const parsed = parseAfterId(afterId);
      const siteId = parsed ? `${parsed.statePath}#${parsed.delayKey}` : afterId;
      const event = { type: "xstate.timer", id: afterId };
      const firings = events.filter(
        (candidate) =>
          candidate.type === event.type &&
          (candidate as EventObject & { id?: unknown }).id === afterId,
      ).length;
      effects.push({
        kind: "delay",
        requestId: `${siteId}#${firings + 1}`,
        id: afterId,
        delayMs: rawAction.delay,
        event,
      });
      continue;
    }

    // Actor-lifecycle bookkeeping the host never runs: the paired
    // `@xstate.start` (starts the child an `@xstate.spawn` already surfaced),
    // `@xstate.stop`/`@xstate.terminate` (teardown of a completed child or the
    // machine itself — children are virtual in the replay model, reconstructed
    // by folding the log, so there is nothing live to stop), an immediate raise
    // (processed inside `transition`), and `registerChild`.
    if (
      rawAction.type === "@xstate.start" ||
      rawAction.type === "@xstate.stop" ||
      rawAction.type === "@xstate.terminate" ||
      rawAction.type === "@xstate.raise" ||
      rawAction.type === "registerChild"
    ) {
      continue;
    }

    // Everything else with an executor is a fire-and-forget action. XState's
    // executable effects carry `exec` as a METHOD that reads `this` (a custom
    // action's `execCustomEffect` reads `this.action`/`this.args`; `sendTo`/
    // `emit`/`cancel` read `this.source`), so it must be invoked on the original
    // action object — never detached into a bare `exec()` call.
    if (typeof rawAction.exec === "function") {
      const action = rawAction;
      effects.push({
        kind: "execute",
        action: rawAction as ExecutableActionObject,
        exec: () => {
          action.exec!();
        },
      });
    }
  }

  // 2. Snapshot-owed children: spawned by an earlier transition and not yet
  // completed. Alpha.24 prunes matching completions from the snapshot; the
  // history check additionally protects older/restored snapshots.
  const children = (snapshot as AnyMachineSnapshot & { children?: Record<string, unknown> })
    .children;
  for (const [id, child] of Object.entries(children ?? {})) {
    if (emitted.has(id) || invokeOccurrence(events, id) > 1) {
      continue;
    }
    const ref = child as
      | { src?: unknown; logic?: unknown; getSnapshot?: () => { input?: unknown } }
      | undefined;
    if (typeof ref?.getSnapshot !== "function") {
      continue;
    }
    const effect = buildInvokeEffect(
      { id, src: ref.src, input: ref.getSnapshot().input, logic: ref.logic },
      requestById.get(id),
      events,
      snapshot,
      resolved,
    );
    if (effect) {
      effects.push(effect);
      emitted.add(id);
    }
  }

  return effects;
}

/** The result of a {@link replay}: the final snapshot and the effects still owed. */
export interface ReplayResult<TMachine extends AnyActorLogic> {
  snapshot: SnapshotFrom<TMachine>;
  effects: AgentEffect[];
}

/** Options for {@link replay}. */
export interface ReplayOptions extends Partial<AgentExecutionOptions> {
  /**
   * Machine input, used only when `entries` has no reserved {@link initEntry}
   * first entry. An init entry (the self-contained log) takes precedence.
   */
  input?: unknown;
  /** Explicit expected machine version; defaults to the structural hash. */
  machineVersion?: string;
  /** Check recorded hashes when present; `'strict'` additionally requires them. */
  verify?: boolean | "strict";
}

export class AgentReplayMachineMismatchError extends AgentError {
  constructor(
    readonly eventId: string,
    readonly index: number,
    readonly expected: { machineId: string; machineVersion: string },
    readonly actual: { machineId: string; machineVersion: string },
  ) {
    super(
      "replay-machine-mismatch",
      `Replay entry '${eventId}' at index ${index} targets machine ` +
        `'${actual.machineId}'@'${actual.machineVersion}', expected ` +
        `'${expected.machineId}'@'${expected.machineVersion}'.`,
    );
    this.name = "AgentReplayMachineMismatchError";
  }
}

export class AgentReplayDivergenceError extends AgentError {
  constructor(
    readonly eventId: string,
    readonly index: number,
    readonly kind: "state" | "effects" | "missing-verification",
    readonly expected?: string,
    readonly actual?: string,
  ) {
    super(
      "replay-divergence",
      kind === "missing-verification"
        ? `Replay entry '${eventId}' at index ${index} has no verification hashes.`
        : `Replay diverged after '${eventId}' at index ${index} (${kind}): ` +
            `expected '${expected}', got '${actual}'.`,
    );
    this.name = "AgentReplayDivergenceError";
  }
}

/** JSON Patch operation returned by {@link diffEventLogs}. */
export type AgentLogPatchOperation =
  | { op: "add"; path: string; value: JsonValue }
  | { op: "remove"; path: string }
  | { op: "replace"; path: string; value: JsonValue };

export interface AgentEffectDiff {
  added: JsonValue[];
  removed: JsonValue[];
  changed: Array<{ before: JsonValue; after: JsonValue }>;
}

export interface AgentEventLogDiff<TMachine extends AnyStateMachine> {
  commonPrefix: { length: number; throughEventId?: string };
  parentOnly: AgentLogEntry[];
  forkOnly: AgentLogEntry[];
  parent: ReplayResult<TMachine>;
  fork: ReplayResult<TMachine>;
  stateChanges: AgentLogPatchOperation[];
  effectChanges: AgentEffectDiff;
}

/**
 * Folds a journal through `initialTransition`/`transition` WITHOUT executing
 * anything, then returns the final snapshot plus the still-owed effects
 * ({@link getAgentEffects} of the final frontier, occurrence counts taken from
 * the whole log). Crash recovery, fork resume, and time travel in one call.
 *
 * `entries` is a versioned {@link AgentLogEntry} array. A reserved
 * {@link initEntry} first envelope carries `{ type: '@agent.init', input }`,
 * so a complete log replays with no side-channel; when absent,
 * `options.input` is used instead.
 * Raised/internal events are never in the journal — replay re-derives them
 * deterministically from the machine's own logic.
 */
/**
 * Validates a replay entry sequence: envelope shape, contiguity from index 0,
 * unique event ids, and machine identity.
 *
 * @internal
 */
export function validateReplayEntries(
  entries: readonly AgentLogEntry[],
  expected: { machineId: string; machineVersion: string },
  label: string,
): void {
  const eventIds = new Set<string>();
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    assertAgentLogEntry(entry);
    if (entry.index !== index) {
      throw new Error(
        `${label} must be contiguous from index 0; found entry.index ${entry.index} ` +
          `at position ${index}.`,
      );
    }
    if (eventIds.has(entry.id)) {
      throw new Error(`${label} contain duplicate event id '${entry.id}'.`);
    }
    eventIds.add(entry.id);
    if (
      entry.machineId !== expected.machineId ||
      entry.machineVersion !== expected.machineVersion
    ) {
      throw new AgentReplayMachineMismatchError(entry.id, entry.index, expected, {
        machineId: entry.machineId,
        machineVersion: entry.machineVersion,
      });
    }
  }
}

export function replay<TMachine extends AnyStateMachine>(
  machine: TMachine,
  entries: readonly AgentLogEntry[],
  options: ReplayOptions = {},
): ReplayResult<TMachine> {
  const machineId = (machine.config as { id?: string }).id ?? machine.id ?? "(machine)";
  const machineVersion = options.machineVersion ?? getMachineStructuralHash(machine);
  validateReplayEntries(entries, { machineId, machineVersion }, "Replay entries");
  const events = toEvents(entries);

  // The reserved init entry, when present, is entry 0: it carries the machine
  // input rather than a journaled event, so everything downstream is offset by
  // one.
  const initOffset = events[0]?.type === AGENT_INIT_EVENT_TYPE ? 1 : 0;
  const input = initOffset ? (events[0] as EventObject & { input?: unknown }).input : options.input;
  const journal = events.slice(initOffset);
  const journalEntries = entries.slice(initOffset);

  let [snapshot, actions] = initialTransition(machine, input as never);
  let effects = getAgentEffects(machine, snapshot as AnyMachineSnapshot, actions, {
    ...options,
    history: entries.slice(0, initOffset),
  });
  if (initOffset) {
    verifyEntry(entries[0]!, snapshot as AnyMachineSnapshot, effects, options.verify);
  }
  const sessions = new Map<string, string>();
  for (let index = 0; index < journal.length; index++) {
    const event = journal[index]!;
    const reboundEvent = rebindActorSession(event, snapshot as AnyMachineSnapshot, sessions);
    [snapshot, actions] = transition(machine, snapshot, reboundEvent as never);
    const consumed = entries.slice(0, initOffset + index + 1);
    effects = getAgentEffects(machine, snapshot as AnyMachineSnapshot, actions, {
      ...options,
      history: consumed,
    });
    verifyEntry(journalEntries[index]!, snapshot as AnyMachineSnapshot, effects, options.verify);
  }

  return { snapshot: snapshot as SnapshotFrom<TMachine>, effects };
}

/** Structural event-tail, logical-state, and owed-effect comparison. */
export function diffEventLogs<TMachine extends AnyStateMachine>(
  machine: TMachine,
  parentEntries: readonly AgentLogEntry[],
  forkEntries: readonly AgentLogEntry[],
  options: ReplayOptions = {},
): AgentEventLogDiff<TMachine> {
  let commonLength = 0;
  while (
    commonLength < parentEntries.length &&
    commonLength < forkEntries.length &&
    stableJson(parentEntries[commonLength]) === stableJson(forkEntries[commonLength])
  ) {
    commonLength++;
  }
  const parent = replay(machine, parentEntries, options);
  const fork = replay(machine, forkEntries, options);
  const parentState = logicalReplayState(parent.snapshot as AnyMachineSnapshot);
  const forkState = logicalReplayState(fork.snapshot as AnyMachineSnapshot);
  return {
    commonPrefix: {
      length: commonLength,
      ...(commonLength > 0 ? { throughEventId: parentEntries[commonLength - 1]!.id } : {}),
    },
    parentOnly: parentEntries.slice(commonLength),
    forkOnly: forkEntries.slice(commonLength),
    parent,
    fork,
    stateChanges: diffJson(parentState, forkState),
    effectChanges: diffEffects(parent.effects, fork.effects),
  };
}

function verifyEntry(
  entry: AgentLogEntry,
  snapshot: AnyMachineSnapshot,
  effects: AgentEffect[],
  mode: ReplayOptions["verify"],
): void {
  if (mode === false) {
    return;
  }
  if (!entry.verification) {
    if (mode === "strict") {
      throw new AgentReplayDivergenceError(entry.id, entry.index, "missing-verification");
    }
    return;
  }
  const actual = replayVerification(snapshot, effects);
  if (actual.stateHash !== entry.verification.stateHash) {
    throw new AgentReplayDivergenceError(
      entry.id,
      entry.index,
      "state",
      entry.verification.stateHash,
      actual.stateHash,
    );
  }
  if (actual.effectsHash !== entry.verification.effectsHash) {
    throw new AgentReplayDivergenceError(
      entry.id,
      entry.index,
      "effects",
      entry.verification.effectsHash,
      actual.effectsHash,
    );
  }
}

function replayVerification(
  snapshot: AnyMachineSnapshot,
  effects: AgentEffect[],
): AgentLogVerification {
  return {
    stateHash: hashStableJson(logicalReplayState(snapshot)),
    effectsHash: hashStableJson(serializableEffects(effects)),
  };
}

function logicalReplayState(snapshot: AnyMachineSnapshot): JsonValue {
  const state: Record<string, unknown> = {
    status: snapshot.status,
    value: snapshot.value,
    context: snapshot.context,
  };
  if (snapshot.output !== undefined) state.output = snapshot.output;
  if (snapshot.error !== undefined) state.error = snapshot.error;
  const canonical = canonicalizeForHash(state);
  assertJsonSerializable(canonical, "snapshot");
  return canonical as JsonValue;
}

function serializableEffects(effects: AgentEffect[]): JsonValue[] {
  return effects.map((effect) => canonicalizeEffect(effect) as JsonValue);
}

function canonicalizeEffect(effect: AgentEffect): unknown {
  if (effect.kind === "execute") {
    return { kind: effect.kind, type: String(effect.action.type) };
  }
  const value = { ...effect } as Record<string, unknown>;
  delete value.toDoneEvent;
  delete value.toErrorEvent;
  delete value.exec;
  delete value.action;
  return canonicalizeForHash(value);
}

function canonicalizeForHash(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === undefined) return "[undefined]";
  if (typeof value === "function") return "[function]";
  if (typeof value === "bigint") return `[bigint:${String(value)}]`;
  if (typeof value === "symbol") return `[symbol:${String(value)}]`;
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return `[Date:${value.toISOString()}]`;
  if (value instanceof Error) {
    return {
      errorName: value.name,
      message: value.message,
      ...(value.cause !== undefined ? { cause: canonicalizeForHash(value.cause, seen) } : {}),
    };
  }
  if (value instanceof Set) {
    return [...value]
      .map((item) => canonicalizeForHash(item, seen))
      .sort((a, b) => stableJson(a).localeCompare(stableJson(b)));
  }
  if (value instanceof Map) {
    return [...value.entries()]
      .map(([key, item]) => [canonicalizeForHash(key, seen), canonicalizeForHash(item, seen)])
      .sort(([a], [b]) => stableJson(a).localeCompare(stableJson(b)));
  }
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) {
    const result = value.map((item) => canonicalizeForHash(item, seen));
    seen.delete(value);
    return result;
  }
  const standard = (value as { "~standard"?: { vendor?: unknown; version?: unknown } })[
    "~standard"
  ];
  if (standard) {
    seen.delete(value);
    return { schemaVendor: standard.vendor, schemaVersion: standard.version };
  }
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    result[key] = canonicalizeForHash((value as Record<string, unknown>)[key], seen);
  }
  seen.delete(value);
  return result;
}

function normalizeEventErrors(
  value: unknown,
  seen: WeakMap<object, unknown> = new WeakMap(),
): unknown {
  if (value instanceof Error) {
    const normalized: Record<string, unknown> = {
      name: value.name,
      message: value.message,
    };
    seen.set(value, normalized);
    if (value.cause !== undefined) normalized.cause = normalizeEventErrors(value.cause, seen);
    return normalized;
  }
  if (value === null || typeof value !== "object") return value;
  const existing = seen.get(value);
  if (existing !== undefined) return existing;
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    seen.set(value, result);
    for (const item of value) result.push(normalizeEventErrors(item, seen));
    return result;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  const result: Record<string, unknown> = {};
  seen.set(value, result);
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    result[key] = normalizeEventErrors(item, seen);
  }
  return result;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, sortJson((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

function hashStableJson(value: unknown): string {
  return djb2Hex(stableJson(value));
}

function diffJson(before: JsonValue, after: JsonValue, path = ""): AgentLogPatchOperation[] {
  if (stableJson(before) === stableJson(after)) return [];
  if (
    before === null ||
    after === null ||
    typeof before !== "object" ||
    typeof after !== "object" ||
    Array.isArray(before) ||
    Array.isArray(after)
  ) {
    return [{ op: "replace", path, value: after }];
  }
  const changes: AgentLogPatchOperation[] = [];
  const beforeObject = before as Record<string, JsonValue>;
  const afterObject = after as Record<string, JsonValue>;
  const keys = new Set([...Object.keys(beforeObject), ...Object.keys(afterObject)]);
  for (const key of [...keys].sort()) {
    const childPath = `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`;
    if (!(key in afterObject)) changes.push({ op: "remove", path: childPath });
    else if (!(key in beforeObject))
      changes.push({ op: "add", path: childPath, value: afterObject[key]! });
    else changes.push(...diffJson(beforeObject[key]!, afterObject[key]!, childPath));
  }
  return changes;
}

function diffEffects(before: AgentEffect[], after: AgentEffect[]): AgentEffectDiff {
  const beforeValues = serializableEffects(before);
  const afterValues = serializableEffects(after);
  const key = (value: JsonValue, index: number): string => {
    const record = value as Record<string, JsonValue>;
    return typeof record.requestId === "string"
      ? record.requestId
      : `${String(record.kind ?? "effect")}:${index}`;
  };
  const beforeMap = new Map(beforeValues.map((value, index) => [key(value, index), value]));
  const afterMap = new Map(afterValues.map((value, index) => [key(value, index), value]));
  const added: JsonValue[] = [];
  const removed: JsonValue[] = [];
  const changed: Array<{ before: JsonValue; after: JsonValue }> = [];
  for (const [id, value] of beforeMap) {
    const next = afterMap.get(id);
    if (next === undefined) removed.push(value);
    else if (stableJson(value) !== stableJson(next)) changed.push({ before: value, after: next });
  }
  for (const [id, value] of afterMap) {
    if (!beforeMap.has(id)) added.push(value);
  }
  return { added, removed, changed };
}
