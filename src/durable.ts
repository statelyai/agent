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
const ERROR_ACTOR_EVENT_TYPE = "xstate.error.actor";

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
    };

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
  // is suppressed while N ≤ its recorded completion count.
  const journaledCompletions = new Map<string, number>();
  for (const event of journal) {
    const actorId = completionActorId(event);
    if (actorId !== undefined) {
      journaledCompletions.set(actorId, (journaledCompletions.get(actorId) ?? 0) + 1);
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

  const adapter: DurableExecutionAdapter<TMachine> = {
    executionId,
    sendEvent(source, target, event) {
      if ((target as { address?: string }).address === rootAddress) {
        mailbox.push(event);
        return;
      }
      deliverEvent(source as never, target as never, event as never);
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
    // The loop below owns event flow; `run()` (which uses this) is never called.
    waitForEvent() {
      return mailbox.take() as Promise<EventFromLogic<TMachine>>;
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
  let liveEventConsumed = false;

  let [snapshot, effects] = execution.initialTransition(input as never);

  for (;;) {
    // Execute the frontier. Suppressed children contribute nothing; live
    // children run through xstate's own runtime. Root events produced while
    // effects settle come back captured, in order.
    const captured = await execution.executeEffects(effects);
    for (const rootEvent of captured) {
      mailbox.push(rootEvent.event);
    }

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
    } else if (mailbox.size() > 0) {
      event = await mailbox.take();
    } else if (
      liveInFlight.size > 0 &&
      !(options.isIdle?.(snapshot as SnapshotFrom<TMachine>) ?? false)
    ) {
      // Live work is in flight (a model call, a task): wait for its event
      // before considering the host's own — the machine is not at rest yet.
      event = await mailbox.take();
    } else if (!liveEventConsumed && options.event !== undefined) {
      event = options.event;
      liveEventConsumed = true;
    } else {
      return {
        status: "idle",
        snapshot: snapshot as SnapshotFrom<TMachine>,
        entries,
      };
    }

    const completedId = completionActorId(event);
    if (completedId !== undefined) {
      liveInFlight.delete(completedId);
    }
    if (!fromJournal) {
      appendEntry(event);
    }
    [snapshot, effects] = execution.transition(snapshot, event as never);
  }
}
