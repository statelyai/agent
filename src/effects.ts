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
  type EventObject,
  type ExecutableActionObject,
  type SnapshotFrom,
} from "xstate";
import { getAgentRequestsWith, getInvokeEffectMetadata, type AgentPlanRequest } from "./steps.js";
import { isDecisionLogic, isPlanLogic, type AgentDecisionRequest } from "./decision.js";
import { isTextLogic, type AgentRequestMode, type AgentTextRequest } from "./text-logic.js";
import { getAcceptedEvents } from "./events.js";
import type { AgentLogEntry } from "./event-log-store.js";
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
 * - `plan` — an `agent.plan` invoke (multi-event). Drive it a step at a time
 *   (see `resolveAgentRequests`), journaling each applied event.
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
  | { kind: "plan"; requestId: string; request: AgentPlanRequest }
  | {
      kind: "task";
      requestId: string;
      id: string;
      src: string;
      input: unknown;
      toDoneEvent(output: unknown): EventObject;
      toErrorEvent(error: unknown): EventObject;
    }
  | { kind: "delay"; requestId: string; id: string; delayMs: number; event: EventObject }
  | { kind: "execute"; action: ExecutableActionObject; exec(): void };

/**
 * The reserved journal event type of the {@link initEntry} first entry: it
 * carries the machine `input` so a log replays with no side-channel. Named in
 * the `agent.*` builtin-actor namespace so it never collides with a machine's
 * own event vocabulary. Consumed by {@link replay}; never fed to `transition`.
 */
export const AGENT_INIT_EVENT_TYPE = "@agent.init" as const;

/**
 * The reserved first journal entry: `{ index: 0, event: { type: '@agent.init',
 * input } }`. Prepend it to a log so {@link replay} can recover the machine
 * `input` from the log alone (no side-channel). See {@link AGENT_INIT_EVENT_TYPE}.
 */
export function initEntry(input?: unknown): AgentLogEntry {
  return { index: 0, event: { type: AGENT_INIT_EVENT_TYPE, input } as EventObject };
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

/** The `xstate.done.actor.<id>` / `xstate.error.actor.<id>` completion types for a site. */
function doneType(id: string): string {
  return `xstate.done.actor.${id}`;
}
function errorType(id: string): string {
  return `xstate.error.actor.${id}`;
}

/**
 * 1-based occurrence for an invoke/spawn site: `1 + completions` (done AND
 * error both count — an error is a semantic completion) for `id` in `events`.
 */
function invokeOccurrence(events: readonly EventObject[], id: string): number {
  const done = doneType(id);
  const error = errorType(id);
  let count = 0;
  for (const event of events) {
    if (event.type === done || event.type === error) {
      count++;
    }
  }
  return count + 1;
}

/** The exact done/error events xstate's actor system delivers for an invoke `id`. */
function invokeEventMinters(id: string): {
  toDoneEvent(output: unknown): EventObject;
  toErrorEvent(error: unknown): EventObject;
} {
  return {
    toDoneEvent: (output: unknown) => ({ type: doneType(id), output, actorId: id }) as EventObject,
    toErrorEvent: (error: unknown) => ({ type: errorType(id), error, actorId: id }) as EventObject,
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

// Builds a text/decision/plan/task effect for one invoke site. Prefers a
// pre-shaped request (from getAgentRequestsWith, which resolves prompts /
// schemas / decision candidate events exactly as the step path does); falls
// back to classifying the logic directly for a snapshot-owed child that no
// action shaped this frontier.
function buildInvokeEffect(
  meta: { id?: unknown; src?: unknown; input?: unknown; logic?: unknown },
  mapped: ReturnType<typeof getAgentRequestsWith>[number] | undefined,
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
      ...invokeEventMinters(id),
    };
  }
  if (mapped?.kind === "decision") {
    return { kind: "decision", requestId, request: mapped };
  }
  if (mapped?.kind === "plan") {
    return { kind: "plan", requestId, request: mapped };
  }

  // No pre-shaped request (a dynamic spawn, or a snapshot-owed child) —
  // classify the logic directly.
  const logic =
    isTextLogic(meta.logic) || isDecisionLogic(meta.logic) || isPlanLogic(meta.logic)
      ? meta.logic
      : typeof meta.src === "string"
        ? options.actorSources?.[meta.src]
        : undefined;

  if (isTextLogic(logic)) {
    const request = logic.request(meta.input as never);
    return { kind: "text", requestId, request, mode: logic.mode, ...invokeEventMinters(id) };
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
  return { kind: "task", requestId, id, src, input: meta.input, ...invokeEventMinters(id) };
}

/**
 * Maps a transition's ORDERED executable actions (plus the still-owed effects
 * visible only on the snapshot) into an ordered {@link AgentEffect} list the
 * host starts at the frontier.
 *
 * Ordering is load-bearing: a single transition's actions are emitted in
 * document order (a custom entry action, a spawn, and a `sendTo` in that order
 * yield `execute`, then `task`/agent effect, then `execute` — never a
 * reordered set). Effects visible only on the snapshot (an `agent.plan` that
 * re-surfaces every step, and children spawned by an EARLIER transition that
 * have not completed yet — the fan-out / crash-resume case) are appended after
 * the action-derived effects, deduped by site id.
 *
 * Every `requestId` is `${siteId}#${n}`, `n` the 1-based occurrence derived
 * from `options.history` — so the same log yields identical requestIds on every
 * replay. Because completed children are NOT pruned from a pure-`transition`
 * snapshot, a snapshot-owed child counts as owed only when it has ZERO
 * journaled completions; a re-entered invoke site instead re-derives from the
 * action list each fresh entry (so `#2`, `#3`, … stay correct).
 */
export function getAgentEffects(
  machine: AnyActorLogic,
  snapshot: AnyMachineSnapshot,
  actions: readonly ExecutableActionObject[],
  options: GetAgentEffectsOptions = {},
): AgentEffect[] {
  const resolved = getRegisteredAgentExecutionOptions(machine, options);
  const events = toEvents(options.history);

  // Pre-shape text/decision requests (in action order) plus any re-surfacing
  // plan requests (from snapshot children) exactly as the step path does.
  const requests = getAgentRequestsWith(actions as unknown as readonly RawAction[], {
    ...resolved,
    snapshot,
  });
  const requestById = new Map(requests.map((request) => [request.id, request]));

  const effects: AgentEffect[] = [];
  const emitted = new Set<string>();

  // 1. Action-derived effects, in document order.
  for (const rawAction of actions as unknown as readonly RawAction[]) {
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
      const event = rawAction.event ?? ({ type: afterId } as EventObject);
      const firings = events.filter((candidate) => candidate.type === event.type).length;
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

    // Everything else with an executor is a fire-and-forget action. alpha.23's
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

  // 2. Re-surfacing plan requests (an `agent.plan` invoke re-surfaces every
  // step from snapshot children, not the action list, after its first step).
  for (const request of requests) {
    if (request.kind === "plan" && !emitted.has(request.id)) {
      effects.push({
        kind: "plan",
        requestId: `${request.id}#${invokeOccurrence(events, request.id)}`,
        request,
      });
      emitted.add(request.id);
    }
  }

  // 3. Snapshot-owed children: spawned by an earlier transition and not yet
  // completed (zero journaled completions). Completed children linger in a
  // pure-`transition` snapshot, so a nonzero completion count means "done."
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
}

/**
 * Folds a journal through `initialTransition`/`transition` WITHOUT executing
 * anything, then returns the final snapshot plus the still-owed effects
 * ({@link getAgentEffects} of the final frontier, occurrence counts taken from
 * the whole log). Crash recovery, fork resume, and time travel in one call.
 *
 * `entries` is an `EventObject[]` or an `AgentLogEntry[]` (both accepted). A
 * reserved {@link initEntry} first entry (`{ type: '@agent.init', input }`)
 * supplies the machine input so a log replays with no side-channel; when
 * absent, `options.input` is used instead (the init entry wins if both exist).
 * Raised/internal events are never in the journal — replay re-derives them
 * deterministically from the machine's own logic.
 */
export function replay<TMachine extends AnyActorLogic>(
  machine: TMachine,
  entries: readonly (EventObject | AgentLogEntry)[],
  options: ReplayOptions = {},
): ReplayResult<TMachine> {
  const events = toEvents(entries);

  let input: unknown = options.input;
  let journal = events;
  if (events[0]?.type === AGENT_INIT_EVENT_TYPE) {
    input = (events[0] as EventObject & { input?: unknown }).input;
    journal = events.slice(1);
  }

  let [snapshot, actions] = initialTransition(machine, input as never);
  for (const event of journal) {
    [snapshot, actions] = transition(machine, snapshot, event as never);
  }

  const effects = getAgentEffects(machine, snapshot as AnyMachineSnapshot, actions, {
    ...options,
    history: journal,
  });

  return { snapshot: snapshot as SnapshotFrom<TMachine>, effects };
}
