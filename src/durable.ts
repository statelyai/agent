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
  initialTransition,
  transition,
  type AnyActor,
  type AnyMachineSnapshot,
  type AnyStateMachine,
  type EventFromLogic,
  type EventObject,
  type ExecutableActionObject,
  type InputFrom,
  type OutputFrom,
  type SnapshotFrom,
} from "xstate";
import {
  AGENT_INIT_EVENT_TYPE,
  agentCallOccurrence,
  createReplayEntry,
  getAgentEffects,
  getLogExecutionId,
  initEntry,
  rebindActorSession,
  replay,
  replayVerification,
  validateReplayEntries,
} from "./effects.js";
import type { AgentLogEntry } from "./event-log-store.js";
import { AgentError } from "./errors.js";
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
  /**
   * Called with each entry as it is appended, for incremental persistence.
   * The second argument is the live snapshot that entry's event produced, so a
   * host can broadcast state per transition without replaying the log.
   */
  onEntry?: (entry: AgentLogEntry, snapshot: SnapshotFrom<TMachine>) => void;
  /**
   * Settle `idle` when this returns true for the current snapshot even though
   * children are still pending — for machines whose wait states keep a
   * never-resolving invoke in flight (e.g. an unbound `agent.userInput`).
   */
  isIdle?: (snapshot: SnapshotFrom<TMachine>) => boolean;
  /** Explicit machine version for entry stamping; defaults to the structural hash. */
  machineVersion?: string;
  /**
   * Record replay-verification hashes on appended entries. On by default:
   * each entry's hashes come from a shadow fold of the UNBOUND machine that
   * the loop steps once per appended event — the same derivation `replay`
   * performs — so recording costs O(1) per entry (no prefix replay). Pass
   * `false` to omit the hashes, which also skips the shadow fold and the
   * re-verification of a resumed journal.
   *
   * A resumed journal is verified for what it carries: strict (every entry
   * must have hashes) only when every prior entry does, and otherwise a
   * tolerant pass that checks the hashes that ARE present and skips the
   * missing ones. So a journal written with `verification: false` still
   * resumes under the default, and a mixed journal verifies its hashed
   * entries — a tampered hashed entry throws
   * `AgentReplayDivergenceError` either way.
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

/**
 * Returned (never thrown) by the adapter's `waitForEvent` when nothing can
 * produce an event: a rejected promise here would be reported as unhandled by
 * runtimes that check before the drive loop's `await` adopts it (workerd does).
 * The loop compares by identity and settles `idle`; it is never transitioned on.
 */
const IDLE_EVENT = { type: "@agent.durable.idle" } as const satisfies EventObject;

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
  const machineId = (machine.config as { id?: string }).id ?? machine.id ?? "(machine)";
  const machineVersion = options.machineVersion ?? resolveMachineVersion(machine);

  // ─── journal intake ───
  const priorEntries = options.entries ?? [];
  if (priorEntries.length > 0) {
    validateReplayEntries(priorEntries, { machineId, machineVersion }, "Durable journal entries");
  }
  const hasInit = priorEntries[0]?.event.type === AGENT_INIT_EVENT_TYPE;
  if (priorEntries.length > 0 && !hasInit) {
    // A journal is resumable only when its reserved `@agent.init` entry is
    // entry 0: it carries the input the fold seeds from, and it is the log
    // lineage `callKey` keys against. Appending one now would push a second
    // `index: 0` into the log and fold from `undefined` input, so refuse.
    throw new AgentError(
      "invalid-journal",
      `runDurableAgent: journal entries must begin with the reserved ` +
        `'${AGENT_INIT_EVENT_TYPE}' entry; found '${priorEntries[0]!.event.type}' at index 0. ` +
        `Resume with the entries a previous runDurableAgent result returned, or pass no ` +
        `entries and start fresh from 'input'.`,
    );
  }
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
  // children a replay re-creates (paired with the rebinding below, which maps
  // a journal recorded before the pinning). Minted once per journal
  // and persisted in the init entry's metadata; a journal that predates the
  // field falls back to its init entry id (deterministic per log).
  const executionId =
    getLogExecutionId(priorEntries) ?? (hasInit ? priorEntries[0]!.id : crypto.randomUUID());

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
      if (
        liveInFlight.size > 0 &&
        !(options.isIdle?.(latestSnapshot as SnapshotFrom<TMachine>) ?? false)
      ) {
        // Live work is in flight (a model call, a task): wait for its event
        // before considering the host's own — the machine is not at rest yet.
        return (await mailbox.take()) as EventFromLogic<TMachine>;
      }
      if (!liveEventConsumed && options.event !== undefined) {
        liveEventConsumed = true;
        return options.event;
      }
      return IDLE_EVENT as unknown as EventFromLogic<TMachine>;
    },
  };

  // ─── per-call idempotency keys (`info.callKey`) ───
  // The same key `runAgent` mints, from the same parts and the same ONE
  // counting rule: `${logId}:${siteId}#${n}`, where `logId` is the journal's
  // `executionId` (pinned in the `@agent.init` entry's metadata, minted once
  // per journal and inherited by resumes and forks — a journal that predates
  // the field has none, and then no key is minted) and
  // `n = agentCallOccurrence(journal prefix) +
  // calls started live this session at that site`. The prefix is `priorEntries`
  // — the journal as it stood when this session began — so a resumed leg lines
  // up: a journal holding one completion for a site re-executes its in-flight
  // call as `#2`, exactly the `requestId` replay derives for it.
  //
  // NOT `startsSeen`: that counter advances on every spawn INCLUDING the
  // suppressed replays of already-journaled calls, and it is bumped at the
  // spawn effect rather than when the executor actually runs. Counting live
  // mints here keeps `n` in step with the calls that reach an executor.
  const liveCallStarts = new Map<string, number>();
  const mintCallKey = (siteId: string): string | undefined => {
    // Read lazily: a fresh run's init entry is appended below, after binding.
    const logId = getLogExecutionId(entries);
    if (logId === undefined) {
      return undefined;
    }
    const startedHere = liveCallStarts.get(siteId) ?? 0;
    liveCallStarts.set(siteId, startedHere + 1);
    return `${logId}:${siteId}#${agentCallOccurrence(priorEntries, siteId) + startedHere}`;
  };

  const bound = options.executors
    ? provideExecutors(machine, options.executors, {
        actors: options.actors,
        onChunk: options.onChunk,
        onTrace: options.onTrace,
        callKey: mintCallKey,
      })
    : options.actors
      ? (machine.provide({ actors: options.actors as never }) as TMachine)
      : machine;

  const execution = createDurable(bound, adapter);

  // ─── the loop ───
  const entries: AgentLogEntry[] = [...priorEntries];
  const verification = options.verification ?? true;
  // Hashes are attached here, from the live frontier — never by
  // `createReplayEntry`'s own prefix replay.
  const entryOptions = { machineVersion, verification: false as const };

  // ─── the shadow pure fold (verification only) ───
  // Hashes MUST describe the UNBOUND machine's derivation, because that is
  // what `replay` re-derives: `provideExecutors` rewrites a builtin invoke's
  // input (it injects `outputSchema`), so the bound execution's own action
  // objects — and any snapshot carrying bound state nodes — hash differently.
  // So the loop keeps a second, purely-derived snapshot alongside the live
  // one and steps it with `transition(machine, …)` for each appended event.
  // One extra pure transition per entry: O(1), no prefix replay.
  let pureSnapshot: AnyMachineSnapshot | undefined;
  // Live child sessionId -> pure-fold child sessionId, per actor id.
  const pureSessions = new Map<string, string>();

  const recordVerification = (
    entry: AgentLogEntry,
    snapshotForHash: AnyMachineSnapshot,
    actionsForHash: readonly ExecutableActionObject[],
  ) => {
    entry.verification = replayVerification(
      snapshotForHash,
      getAgentEffects(machine, snapshotForHash, actionsForHash, { history: entries }),
    );
  };

  const appendEntry = (event: EventObject, frontierSnapshot: unknown) => {
    const entry = createReplayEntry(machine, entries, event, entryOptions);
    entries.push(entry);
    if (verification && pureSnapshot) {
      // The pure counterpart of the transition the execution just ran. The
      // event names the LIVE child's session; rebind it onto the pure fold's
      // child exactly as `replay` does.
      const pureEvent = rebindActorSession(event, pureSnapshot, pureSessions);
      const [nextPure, pureActions] = transition(
        machine,
        pureSnapshot as never,
        pureEvent as never,
      );
      pureSnapshot = nextPure as AnyMachineSnapshot;
      recordVerification(entry, pureSnapshot, pureActions);
    }
    options.onEntry?.(entry, frontierSnapshot as SnapshotFrom<TMachine>);
  };

  const initLogEntry = hasInit
    ? undefined
    : initEntry(machine, input, { ...entryOptions, metadata: { executionId } });
  if (initLogEntry) {
    entries.push(initLogEntry);
  }

  let journalIndex = 0;
  // Original-incarnation sessionId -> this run's child sessionId, per actor id.
  const journalSessions = new Map<string, string>();

  let [snapshot, effects] = execution.initialTransition(input as never);
  latestSnapshot = snapshot;
  if (initLogEntry) {
    // The init entry's hashes describe the initial frontier, matching what
    // `replay` verifies for entry 0 — derived from the UNBOUND machine.
    if (verification) {
      const [initialPure, pureActions] = initialTransition(machine, input as never);
      pureSnapshot = initialPure as AnyMachineSnapshot;
      recordVerification(initLogEntry, pureSnapshot, pureActions);
    }
    options.onEntry?.(initLogEntry, snapshot as SnapshotFrom<TMachine>);
  }

  if (verification && priorEntries.length > 0) {
    // Resume check: one pure fold of the journal (no executors, nothing
    // executed) that throws `AgentReplayDivergenceError` at the first entry
    // whose recorded hashes disagree with what the machine re-derives — the
    // nondeterminism a durable resume would otherwise carry forward silently.
    // Cost is one replay per resume, linear in journal length, not per entry.
    // Its final snapshot seeds the shadow pure fold, so a resumed leg's own
    // appended entries are hashed off the same pure chain (no second fold).
    //
    // MIXED JOURNALS: `'strict'` additionally REQUIRES a hash on every entry,
    // so a journal recorded with `verification: false` would fail at entry 0
    // for having no hashes rather than for diverging. Demand `'strict'` only
    // when every prior entry actually carries hashes; otherwise verify what is
    // there (`verify: true` checks present hashes, skips missing ones).
    // Entries appended by THIS leg are hashed either way.
    const allHashed = priorEntries.every((entry) => entry.verification !== undefined);
    const resumed = replay(machine, priorEntries, {
      machineVersion,
      verify: allHashed ? "strict" : true,
    });
    pureSnapshot = resumed.snapshot as AnyMachineSnapshot;
  }

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
      // run. Session ids are deterministic under the pinned `executionId`, and
      // the rebinding maps any completion recorded against another incarnation.
      // Completions name the original incarnation's child session: rebind them
      // onto this fold's child, so the completion actually matches.
      event = rebindActorSession(
        journal[journalIndex]!,
        snapshot as AnyMachineSnapshot,
        journalSessions,
      );
      journalIndex++;
      fromJournal = true;
      replaying = journalIndex < journal.length;
    } else {
      // Captured root events first, then the adapter's durable wait; the
      // adapter returns the IDLE sentinel when nothing can produce an event.
      event = await execution.waitForEvent();
      if (event === (IDLE_EVENT as EventObject)) {
        return {
          status: "idle",
          snapshot: snapshot as SnapshotFrom<TMachine>,
          entries,
        };
      }
    }

    const completedId = completionActorId(event);
    if (completedId !== undefined) {
      liveInFlight.delete(completedId);
    }
    [snapshot, effects] = execution.transition(snapshot, event as never);
    latestSnapshot = snapshot;
    if (!fromJournal) {
      // Appended after the transition so the entry's hashes can read the
      // frontier this event produced (re-derived on the shadow pure fold).
      appendEntry(event, snapshot);
    }
  }
}
