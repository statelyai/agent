/**
 * The durable host runner: {@link runDurableAgent} drives an executor-bound
 * agent machine on xstate's `createDurable` execution (`xstate/durable`),
 * with the agent event log as the journal.
 *
 * Where {@link replay} + `getAgentEffects` hand a host an effect list to run
 * itself, `runDurableAgent` owns the whole loop on the durable runtime:
 * invoked actors execute live through xstate's own runtime, every EXTERNAL
 * event (invoke completions included) is appended to the log, and a resume
 * folds the log back through pure transitions — an invoke whose completion is
 * already journaled is never re-started, so recorded model calls are never
 * re-executed. Crash recovery re-runs only the work that was still in flight.
 *
 * @module
 */
import { createDurable, type DurableExecutionAdapter } from "xstate/durable";
import {
  deliverEvent,
  type AnyActor,
  type AnyMachineSnapshot,
  type AnyStateMachine,
  type EventFromLogic,
  type EventObject,
  type InputFrom,
  type OutputFrom,
  type SnapshotFrom,
} from "xstate";
import {
  AGENT_INIT_EVENT_TYPE,
  createReplayEntry,
  initEntry,
  validateReplayEntries,
} from "./effects.js";
import type { AgentLogEntry } from "./event-log-store.js";
import { resolveMachineVersion } from "./utils.js";
import { provideExecutors, type ProvideExecutorsOptions } from "./provide-executors.js";
import type { AgentRequestExecutors } from "./text-logic.js";

const DONE_ACTOR_EVENT_TYPE = "xstate.done.actor";
const TIMER_EVENT_TYPE = "xstate.timer";
const ERROR_ACTOR_EVENT_TYPE = "xstate.error.actor";

function timerEventId(event: EventObject): string | undefined {
  if (event.type !== TIMER_EVENT_TYPE) {
    return undefined;
  }
  const id = (event as EventObject & { id?: unknown }).id;
  return typeof id === "string" ? id : undefined;
}

function completionActorId(event: EventObject): string | undefined {
  if (event.type !== DONE_ACTOR_EVENT_TYPE && event.type !== ERROR_ACTOR_EVENT_TYPE) {
    return undefined;
  }
  const actorId = (event as EventObject & { actorId?: unknown }).actorId;
  return typeof actorId === "string" ? actorId : undefined;
}

/** Options for {@link runDurableAgent}. */
export interface RunDurableAgentOptions<TMachine extends AnyStateMachine> extends Pick<
  ProvideExecutorsOptions<TMachine>,
  "actors" | "onChunk" | "onTrace"
> {
  /** Machine input for a FRESH run (ignored when `entries` has an init entry). */
  input?: InputFrom<TMachine>;
  /**
   * The journal to resume from — the `entries` a previous
   * {@link runDurableAgent} result returned (or any replay-compatible
   * {@link AgentLogEntry} log with a reserved `@agent.init` first entry).
   */
  entries?: readonly AgentLogEntry[];
  /** One external event to feed after the journal is folded (a user reply, a timer). */
  event?: EventFromLogic<TMachine>;
  /** Host executors, bound with {@link provideExecutors} semantics. */
  executors?: AgentRequestExecutors;
  /** Called with each entry as it is appended, for incremental persistence. */
  onEntry?: (entry: AgentLogEntry) => void;
  /**
   * Settle `idle` when this returns true for the current snapshot even though
   * children are still pending — for machines whose wait states keep a
   * never-resolving invoke in flight (e.g. an unbound `agent.userInput`).
   */
  isIdle?: (snapshot: SnapshotFrom<TMachine>) => boolean;
  /** Explicit machine version for entry stamping; defaults to the structural hash. */
  machineVersion?: string;
  /**
   * How `after(...)` delays are executed.
   *
   * - `'live'` (default): each logical timer runs on a real in-process
   *   `setTimeout`; the run stays open until it fires (or its state is
   *   exited) and the firing is journaled like any other event.
   * - `'external'`: timers are recorded but never armed. The run settles
   *   `idle` with {@link DurableAgentResult} `pendingTimers`; the host owns
   *   the clock (an alarm, a delayed message, a cron) and resumes with the
   *   timer's firing event: `{ type: 'xstate.timer', id }`. A stale firing —
   *   its state already exited — is ignored by the machine, so at-least-once
   *   host schedulers are safe.
   */
  timers?: "live" | "external";
  /**
   * Record replay-verification hashes on appended entries. Off by default:
   * hashing replays the whole prefix per entry, which is quadratic in log
   * length.
   */
  verification?: boolean;
}

/** The settled result of a {@link runDurableAgent} call. */
export type DurableAgentResult<TMachine extends AnyStateMachine> =
  | {
      /** The machine reached a final state. */
      status: "done";
      output: OutputFrom<TMachine>;
      snapshot: SnapshotFrom<TMachine>;
      /** The complete journal; replaying it reproduces this run. */
      entries: AgentLogEntry[];
    }
  | {
      /** The machine is waiting for an external event. Persist `entries`; resume with them plus `event`. */
      status: "idle";
      snapshot: SnapshotFrom<TMachine>;
      entries: AgentLogEntry[];
      /**
       * Logical timers pending at the frontier (`timers: 'external'` hosts
       * schedule a wake-up from these and resume with
       * `{ type: 'xstate.timer', id }`).
       */
      pendingTimers: PendingDurableTimer[];
    };

/** One pending `after(...)` timer at an idle frontier. */
export interface PendingDurableTimer {
  /** The logical timer id — deterministic, derived from the machine's structure. */
  id: string;
  /** The declared delay, in milliseconds. */
  delayMs: number;
}

/** Thrown by the adapter's `waitForEvent` when nothing can produce an event. */
const IDLE = Symbol("agent.durable.idle");

interface Mailbox {
  push(event: EventObject): void;
  take(): Promise<EventObject>;
  size(): number;
}

function createMailbox(): Mailbox {
  const queue: EventObject[] = [];
  const waiters: Array<(event: EventObject) => void> = [];
  return {
    push(event) {
      const waiter = waiters.shift();
      if (waiter) {
        waiter(event);
      } else {
        queue.push(event);
      }
    },
    take() {
      const next = queue.shift();
      if (next !== undefined) {
        return Promise.resolve(next);
      }
      return new Promise((resolve) => waiters.push(resolve));
    },
    size: () => queue.length,
  };
}

/**
 * Runs an agent machine as a durable execution: journal in, journal out.
 *
 * A fresh call starts from `input` and appends a reserved init entry; a
 * resume call folds `entries` through pure transitions first — invokes whose
 * completions are journaled are suppressed (their recorded results replay
 * instead of re-executing), while work that was in flight at the crash
 * re-executes live. After the journal, an optional `options.event` is
 * delivered. The call settles:
 *
 * - `done` when the machine reaches a final state, with `output`;
 * - `idle` when the frontier needs an external event the host has not
 *   supplied (no live work pending, or `isIdle` says the pending work is a
 *   human wait). Persist `entries` and call again with them later.
 *
 * ```ts
 * const first = await runDurableAgent(machine, { input, executors });
 * // ... persist first.entries; later, in a new process:
 * const next = await runDurableAgent(machine, {
 *   entries: first.entries,
 *   event: { type: "APPROVE" },
 *   executors,
 * });
 * ```
 *
 * @experimental Built on xstate's experimental `xstate/durable` entrypoint.
 */
export async function runDurableAgent<TMachine extends AnyStateMachine>(
  machine: TMachine,
  options: RunDurableAgentOptions<TMachine> = {},
): Promise<DurableAgentResult<TMachine>> {
  const bound = options.executors
    ? provideExecutors(machine, options.executors, {
        actors: options.actors,
        onChunk: options.onChunk,
        onTrace: options.onTrace,
      })
    : options.actors
      ? (machine.provide({ actors: options.actors as never }) as TMachine)
      : machine;

  const machineId = (machine.config as { id?: string }).id ?? machine.id ?? "(machine)";
  const machineVersion = options.machineVersion ?? resolveMachineVersion(machine);

  // ─── journal intake ───
  const priorEntries = options.entries ?? [];
  if (priorEntries.length > 0) {
    validateReplayEntries(priorEntries, { machineId, machineVersion }, "Durable journal entries");
  }
  const hasInit = priorEntries[0]?.event.type === AGENT_INIT_EVENT_TYPE;
  const input = hasInit
    ? (priorEntries[0]!.event as EventObject & { input?: unknown }).input
    : options.input;
  // Journal events to fold, in order (init entry excluded — it carries input).
  const journal = priorEntries.slice(hasInit ? 1 : 0).map((entry) => entry.event);

  // Completions already recorded, per invoke site id: the Nth start of a site
  // is suppressed while N ≤ its recorded completion count. Timer firings get
  // the same treatment per logical timer id, so a replayed frontier never
  // re-arms a timer whose firing is already journaled.
  const journaledCompletions = new Map<string, number>();
  const journaledTimerFirings = new Map<string, number>();
  for (const event of journal) {
    const actorId = completionActorId(event);
    if (actorId !== undefined) {
      journaledCompletions.set(actorId, (journaledCompletions.get(actorId) ?? 0) + 1);
    }
    const timerId = timerEventId(event);
    if (timerId !== undefined) {
      journaledTimerFirings.set(timerId, (journaledTimerFirings.get(timerId) ?? 0) + 1);
    }
  }

  // ─── execution identity ───
  // Pinning `executionId` makes session ids a deterministic function of
  // actor-creation order (`<executionId>:<n>`), so journaled completion
  // events — which carry the producing incarnation's `sessionId` — match the
  // children a replay re-creates, with no rewriting. Minted once per journal
  // and persisted in the init entry's metadata; a journal that predates the
  // field falls back to its init entry id (deterministic per log).
  const storedExecutionId = hasInit
    ? (priorEntries[0]!.metadata as { executionId?: unknown } | undefined)?.executionId
    : undefined;
  const executionId =
    typeof storedExecutionId === "string"
      ? storedExecutionId
      : hasInit
        ? priorEntries[0]!.id
        : crypto.randomUUID();

  // ─── adapter ───
  const mailbox = createMailbox();
  const rootAddress = machineId;
  // Start decisions are made at the spawn effect and honored by the paired
  // start effect via the child ref itself.
  const suppressedChildren = new WeakSet<object>();
  const startsSeen = new Map<string, number>();
  // Invoke ids started live this run and not yet completed — pending work.
  const liveInFlight = new Set<string>();
  const timersMode = options.timers ?? "live";
  // Pending logical timers by id. In 'live' mode each holds its armed
  // setTimeout handle; in 'external' mode `handle` stays undefined and the
  // set is surfaced on the idle result instead.
  const pendingTimers = new Map<
    string,
    { delayMs: number; handle?: ReturnType<typeof setTimeout> }
  >();
  const timersSeen = new Map<string, number>();
  const clearPendingTimer = (id: string) => {
    const pending = pendingTimers.get(id);
    if (pending?.handle !== undefined) {
      clearTimeout(pending.handle);
    }
    pendingTimers.delete(id);
  };
  // Disarms armed setTimeouts without forgetting the timers, for an idle
  // settle: an orphaned handle would keep the process alive and fire into a
  // discarded mailbox. The timers stay in `pendingTimers` so the idle result
  // reports them — their firings were never journaled, so a resume re-arms
  // them (restarting the full delay) or an external scheduler wakes the run.
  const disarmPendingTimers = () => {
    for (const pending of pendingTimers.values()) {
      if (pending.handle !== undefined) {
        clearTimeout(pending.handle);
        pending.handle = undefined;
      }
    }
  };

  const findChildRef = (effect: unknown): (AnyActor & { id: string }) | undefined => {
    const raw = effect as { actor?: unknown; args?: unknown[] };
    const candidates = [raw.actor, ...(Array.isArray(raw.args) ? raw.args : [])];
    for (const candidate of candidates) {
      const ref = candidate as { sessionId?: unknown; id?: unknown; address?: unknown } | undefined;
      if (ref && typeof ref.sessionId === "string" && typeof ref.id === "string") {
        return ref as AnyActor & { id: string };
      }
    }
    return undefined;
  };

  // True while the loop is still consuming `journal` — replayed frontiers must
  // not re-run fire-and-forget actions.
  let replaying = journal.length > 0;
  let liveEventConsumed = false;
  // The current snapshot, for the adapter's `isIdle` consultation.
  let latestSnapshot: SnapshotFrom<TMachine>;

  const adapter: DurableExecutionAdapter<TMachine> = {
    executionId,
    sendEvent(source, target, event) {
      if ((target as { address?: string }).address === rootAddress) {
        mailbox.push(event);
        return;
      }
      deliverEvent(source as never, target as never, event as never);
    },
    scheduleTimer(_source, id, delay) {
      const seen = (timersSeen.get(id) ?? 0) + 1;
      timersSeen.set(id, seen);
      if (seen <= (journaledTimerFirings.get(id) ?? 0)) {
        // This occurrence already fired in the journal; the replayed firing
        // event advances the machine.
        return;
      }
      pendingTimers.set(id, {
        delayMs: delay,
        ...(timersMode === "live"
          ? {
              handle: setTimeout(() => {
                pendingTimers.delete(id);
                mailbox.push({ type: TIMER_EVENT_TYPE, id } as EventObject);
              }, delay),
            }
          : {}),
      });
    },
    cancelTimer(_source, id) {
      clearPendingTimer(id);
    },
    cancelAllTimers() {
      for (const id of [...pendingTimers.keys()]) {
        clearPendingTimer(id);
      }
    },
    runtime(_metadata, effect) {
      const type = (effect as { type?: string }).type;
      if (type === "@xstate.spawn" || type === "@xstate.start") {
        const child = findChildRef(effect);
        if (!child) {
          return {};
        }
        if (type === "@xstate.spawn") {
          const seen = (startsSeen.get(child.id) ?? 0) + 1;
          startsSeen.set(child.id, seen);
          if (seen <= (journaledCompletions.get(child.id) ?? 0)) {
            suppressedChildren.add(child as object);
          } else {
            liveInFlight.add(child.id);
          }
        }
        if (suppressedChildren.has(child as object)) {
          return { spawnActor() {}, startActor() {} };
        }
      }
      return {};
    },
    executeAction(action) {
      // Fire-and-forget custom actions run once, at the live frontier — a
      // replayed frontier re-derives state only, exactly like `replay`.
      if (replaying) {
        return;
      }
      const executable = action as unknown as { exec?: () => void };
      executable.exec?.();
    },
    // Consulted by `execution.waitForEvent()` once no captured root events
    // are retained: pending mailbox deliveries first, then a wait on live
    // in-flight work, then the host's own `options.event` — and when none of
    // those can produce anything, the run is idle.
    async waitForEvent() {
      if (mailbox.size() > 0) {
        return (await mailbox.take()) as EventFromLogic<TMachine>;
      }
      const armedTimers =
        timersMode === "live" &&
        [...pendingTimers.values()].some((timer) => timer.handle !== undefined);
      if (
        (liveInFlight.size > 0 || armedTimers) &&
        !(options.isIdle?.(latestSnapshot as SnapshotFrom<TMachine>) ?? false)
      ) {
        // Live work is in flight (a model call, a task, an armed timer): wait
        // for its event before considering the host's own — the machine is
        // not at rest yet.
        return (await mailbox.take()) as EventFromLogic<TMachine>;
      }
      if (!liveEventConsumed && options.event !== undefined) {
        liveEventConsumed = true;
        return options.event;
      }
      throw IDLE;
    },
  };

  const execution = createDurable(bound, adapter);

  // ─── the loop ───
  const entries: AgentLogEntry[] = [...priorEntries];
  const entryOptions = {
    machineVersion,
    verification: options.verification ?? false,
  };
  const appendEntry = (event: EventObject) => {
    const entry = createReplayEntry(machine, entries, event, entryOptions);
    entries.push(entry);
    options.onEntry?.(entry);
  };
  if (!hasInit) {
    const entry = initEntry(machine, input, {
      ...entryOptions,
      metadata: { executionId },
    });
    entries.push(entry);
    options.onEntry?.(entry);
  }

  let journalIndex = 0;

  let [snapshot, effects] = execution.initialTransition(input as never);
  latestSnapshot = snapshot;

  for (;;) {
    // Execute the frontier. Suppressed children contribute nothing; live
    // children run through xstate's own runtime. Root events produced while
    // effects settle are retained by the execution, in order, and handed out
    // by `execution.waitForEvent()` below.
    await execution.executeEffects(effects);

    const machineSnapshot = snapshot as AnyMachineSnapshot;
    if (machineSnapshot.status === "done") {
      return {
        status: "done",
        output: machineSnapshot.output as OutputFrom<TMachine>,
        snapshot: snapshot as SnapshotFrom<TMachine>,
        entries,
      };
    }
    if (machineSnapshot.status === "error") {
      throw machineSnapshot.error;
    }

    let event: EventObject;
    let fromJournal = false;
    if (journalIndex < journal.length) {
      // Journal first: it is the authoritative total order of the original
      // run. Session ids are deterministic under the pinned `executionId`, so
      // a journaled completion matches the replay's re-created child as-is.
      event = journal[journalIndex]!;
      journalIndex++;
      fromJournal = true;
      replaying = journalIndex < journal.length;
    } else {
      // Captured root events first, then the adapter's durable wait; the
      // adapter throws IDLE when nothing can produce an event.
      try {
        event = await execution.waitForEvent();
      } catch (error) {
        if (error === IDLE) {
          disarmPendingTimers();
          return {
            status: "idle",
            snapshot: snapshot as SnapshotFrom<TMachine>,
            entries,
            pendingTimers: [...pendingTimers.entries()].map(([id, timer]) => ({
              id,
              delayMs: timer.delayMs,
            })),
          };
        }
        throw error;
      }
    }

    const completedId = completionActorId(event);
    if (completedId !== undefined) {
      liveInFlight.delete(completedId);
    }
    const firedTimerId = timerEventId(event);
    if (firedTimerId !== undefined) {
      clearPendingTimer(firedTimerId);
    }
    if (!fromJournal) {
      appendEntry(event);
    }
    [snapshot, effects] = execution.transition(snapshot, event as never);
    latestSnapshot = snapshot;
  }
}
