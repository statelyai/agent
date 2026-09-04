---
title: The event log
description: The event log is the source of truth. Append external inputs, replay deterministically, fork and diff, persist to SQLite.
---

> **Alpha:** `@statelyai/agent` 2.0 is in alpha. APIs can change between releases; pin an exact version. Feedback: [github.com/statelyai/agent](https://github.com/statelyai/agent/issues).

This page describes the event log: what it records, how replay uses it, and how to store, fork, and verify it.

## The model

A machine's durable state is the ordered array of **external inputs** it has received, not a snapshot. External inputs are effect completions (done or error, with outputs inline), user-sent events, and timer firings. Transitions are pure, so folding that array through the machine reconstructs the exact snapshot, including which effects were started and which are still owed. Everything else is derived from the log.

Log external inputs only. Replay re-derives raised and internal events, so logging them applies them twice. The log captures concurrency rather than re-running it: the recorded completion order is the serialization, so replay is deterministic even when the live run raced.

This places one obligation on machine authors. Transitions and effect inputs such as prompt builders and spawn inputs must be pure functions of state and event. Do not call `Date.now()` or `Math.random()` inside transition code. Inject time and randomness as events or as input.

<!-- viz: data flow: external inputs (effect done/error, user events, timer firings) appended to log -> fold through pure transitions -> snapshot + owed effects; raised/internal events shown as re-derived, not logged -->

## Rules of the event log

<!-- verified against src/run-agent.ts (append filter), src/effects.ts (createReplayEntry, verifyEntry), src/event-log-store.ts (append) -->

Four rules keep a log replayable. The library enforces each rule, or detects it the moment it is broken.

**Journal external inputs only.** `replay` re-derives raised and internal events, so recording them applies them twice. `runAgent` filters them out already. The rule matters when you build entries yourself.

```ts no-check
// Wrong: a self-sent event, already re-derived on replay.
entries.push(createReplayEntry(machine, entries, { type: "RETRY" })); // raised inside the machine

// Right: only what came from outside (effect completions, user events, timers).
entries.push(createReplayEntry(machine, entries, { type: "APPROVE" })); // sent by a human
```

**Keep transitions and effect inputs pure.** No static check detects `Date.now()` or `Math.random()` in machine code. The per-entry `verification` hashes catch it on the next replay and throw `AgentReplayDivergenceError`. Inject time and randomness instead.

```ts no-check
// Wrong: the prompt differs on every replay, so effectsHash diverges.
input: () => ({ prompt: `Today is ${new Date().toDateString()}` }),

// Right: the value is in context, put there by an event or the run input.
input: ({ context }) => ({ prompt: `Today is ${context.today}` }),
```

**Never mutate a journaled entry.** `AgentEventLogStore` has exactly four methods: `append`, `read`, `length`, and `fork`. There is no update and no delete. The in-memory store clones on write and on read, so an edit through a caller's reference does not stick. A rewritten entry would also invalidate every hash after it.

```ts no-check
// Wrong: the entry is already the source of truth for everything downstream.
entries[3]!.event = { type: "APPROVE" };

// Right: branch, then append the different event to the new thread.
await store.fork({ threadId: "session-1", newThreadId: "what-if", upToIndex: 3 });
await store.append({ threadId: "what-if", expectedIndex: 3, entries: [correctedEntry] });
```

`upToIndex` is exclusive. `upToIndex: 3` copies entries 0, 1, and 2, so the new thread has length 3 and the next append expects index 3.

**Append at the length you read.** `expectedIndex` provides optimistic concurrency. A stale writer fails with `AgentEventLogConflictError` instead of interleaving. Entries must be contiguous from that index, and event ids must be unique within the thread.

```ts no-check
// Wrong: guesses the position.
await store.append({ threadId, expectedIndex: 0, entries: newEntries });

// Right: read the current length first. A conflict means another writer advanced the thread.
await store.append({ threadId, expectedIndex: await store.length(threadId), entries: newEntries });
```

## Export events from `runAgent`

<!-- RunAgentResult.events and RunAgentOptions events/onEvent from src/run-agent.ts; replay from src/effects.ts -->

Every `runAgent` result carries the external inputs it observed as a versioned `AgentLogEntry[]`. Pass it directly to `replay`.

```ts
import { replay, runAgent } from "@statelyai/agent";

const first = await runAgent(machine, { input, executors });
const { snapshot, effects } = replay(machine, first.events);
```

A fresh run starts with an envelope around `@agent.init`. The remaining entries wrap effect completions and failures, externally sent events, and timer firings. Raised events and internal transitions are absent, because `replay` re-derives them.

```ts
interface AgentLogEntry {
  schemaVersion: 1;
  id: string;
  index: number;
  recordedAt: string;
  machineId: string;
  machineVersion: string;
  event: EventObject;
  causationId?: string;
  correlationId?: string;
  verification?: { stateHash: string; effectsHash: string };
  metadata?: Record<string, JsonValue>;
}
```

- `recordedAt` is acceptance metadata, not semantic machine time. If a transition needs time, put the time in the machine event itself.
- `machineVersion` is the machine's own `version` from `createMachine({ version })`. Without a declared version, it is the machine's structural hash.
- `verification` pins the logical state and the still-owed effects after each entry.

XState v6 uses stable category event types and carries identity in payload fields. Preserve the whole event object. An invoke completion is `{ type: "xstate.done.actor", actorId, sessionId, output }`. A timer firing is `{ type: "xstate.timer", id }`. `replay` rebinds logged actor sessions to the new actor system, so globally unique runtime ids do not make the log machine-specific.

When resuming by snapshot, pass the preceding events back to keep one complete history.

```ts
const second = await runAgent(machine, {
  snapshot: first.snapshot,
  event: { type: "APPROVE" },
  events: first.events,
  executors,
});

replay(machine, second.events);
```

When the events passed are a self-contained log, that log is the resume source and the `snapshot` is a cache of it. See [Resume precedence](#resume-precedence).

If you omit `events` on a snapshot resume, the returned array contains only the events observed during that invocation, and it is not a complete replay from initialization.

To capture the same replayable events while the run is in flight, use `onEvent`.

```ts
const events = [...previousEvents];

const result = await runAgent(machine, {
  snapshot,
  event,
  events: previousEvents,
  executors,
  onEvent: (entry) => {
    events.push(entry);
    appendToStore(entry);
  },
});
```

- `onEvent` fires once per newly observed envelope, including the `@agent.init` entry on a fresh run.
- It does not re-emit history supplied through `events`.
- It excludes raised and internal events, unlike `onTransition`, so its output can be passed straight to `replay`.

`runAgent` owns a live XState actor. Its `onEvent` callback observes an event after XState accepted it, and it cannot await an asynchronous store before the transition. Use it for export and write-through recording. It is not an append-before-transition crash-safety guarantee. For that guarantee, use [the step path](steps.md#durable-append-before-continue).

## Log-only resume (crash recovery)

<!-- events-only resume from src/run-agent.ts (options.events + replay + getPersistedSnapshot); tests in src/run-agent.test.ts "restore semantics" -->

A log is self-contained when its first entry is the reserved `@agent.init` entry. Every fresh `runAgent` log is self-contained. That entry carries the machine input plus `metadata.executionId`, a UUID minted once per log that identifies the lineage: it is inherited verbatim by every resume, copied by every fork, and it is what `agentMeta.logId` and `info.callKey` are keyed on (`getLogExecutionId(entries)` reads it). Given such a log, `runAgent` derives the resume state from the log itself.

```ts
const recovered = await runAgent(machine, {
  events: persistedEntries, // no snapshot
  executors,
});
```

- Recorded results are replayed, never re-executed. A model call whose completion is in the log runs zero times during recovery.
- A request that was in flight when the log ended has no recorded completion. It round-trips as a pending child and re-executes on restore, because XState v6 restarts restored pending invokes.
- The recovered result's `events` extends the same log, so the whole history stays replayable.

- A log that already reached a final state settles immediately with `status: "done"` and the recorded output.

> **Warning:** Resume fan-out from the log, not from a mid-flight live snapshot. `replay` re-derives spawned branches that are still owed. Restoring a live `runAgent` snapshot that was persisted mid-flight drops frozen children instead. See [Roadmap](roadmap.md#near-term-non-gating).

This is the crash-recovery path for hosts that persist entries as they happen, through `onEvent` or an event-log store. After a process dies mid-run, resume from the log alone. Restart is at-least-once for the in-flight request, so executors with non-idempotent side effects should deduplicate by their own idempotency key. See [`examples/crash-recovery`](../examples/crash-recovery/index.ts).

<!-- viz: crash recovery sequence: host appends entries -> process dies mid-request -> restart with events only -> replay recorded completions -> in-flight request re-executed -> run continues -->


## The JSON wire contract

`createReplayEntry`, `initEntry`, `replay`, and every built-in store append validate the complete envelope. Values that JSON would drop or coerce are rejected with `NonSerializableAgentEventError`, which carries the exact `path`. The rejected values are `undefined`, functions, symbols, bigint, non-finite numbers, negative zero, sparse arrays, hidden properties, cycles, `Date`, `Map`, `Set`, and class instances. Framework error events normalize `Error` values to plain `{ name, message, cause? }` records before storage.

Use `assertJsonSerializable(value)` and `assertAgentLogEntry(entry)` at custom transport boundaries. This strict subset makes an exported log mean the same thing in another process or another language.

## Strict replay verification

`createReplayEntry` and `initEntry` write the `verification` hashes, and they do so by default. Hashes are absent in one case: `runAgent` resuming from a snapshot whose log does not start at the `@agent.init` entry, because that replay history is incomplete.

`runDurableAgent` also records hashes by default. It takes them straight from the live snapshot and the frontier effects of the transition it just made, so recording is O(1) per entry and the hashes are identical to a pure fold's. On resume it re-verifies the journal it was handed — one pure fold, no executors and nothing executed — so nondeterminism surfaces at the diverging entry rather than compounding. Pass `verification: false` to opt out of both.

A resumed journal is verified for what it carries. `{ verify: 'strict' }` is used only when every prior entry has hashes; a journal with any hash-free entry (one written with `verification: false`) is verified with `{ verify: true }` instead, which checks the hashes that are present and skips the missing ones. So a hash-free journal still resumes under the default, a mixed journal still throws on a tampered hashed entry, and entries the new leg appends are hashed either way.

A journal must begin with its reserved `@agent.init` entry. `runDurableAgent` throws `AgentError` with `code: 'invalid-journal'` for a non-empty `entries` that does not — the init entry carries the input the fold seeds from and the lineage `callKey` keys against, so there is nothing to resume from without it.

`replay` has three verification modes.

| `verify` | Behavior |
| --- | --- |
| default | Checks every entry that carries hashes. Entries without hashes pass. |
| `'strict'` | Requires hashes on every entry. An entry without them throws `AgentReplayDivergenceError` with `kind: 'missing-verification'`. |
| `false` | Runs no checks. |

Pass `{ verify: 'strict' }` to require hashes on every entry and fail at the first mismatch.

```ts
import { AgentReplayDivergenceError, replay } from "@statelyai/agent";

try {
  replay(machine, entries, { verify: "strict" });
} catch (error) {
  if (error instanceof AgentReplayDivergenceError) {
    console.error(error.eventId, error.index, error.kind);
  }
}
```

- `kind: "state"` means the current machine derived a different logical state.
- `kind: "effects"` means the machine owed different work, caused by a changed prompt, model, tool set, task input, or timer.
- `kind: "missing-verification"` means an entry carried no hashes.
- `AgentReplayMachineMismatchError` rejects an envelope stamped for another machine id or version before folding it.

Every framework error extends `AgentError` and carries a stable `.code` string, such as `"replay-divergence"`, `"event-log-conflict"`, or `"non-serializable-event"`. A host can branch on the code instead of on `instanceof`. The other durability-adjacent errors are `AgentIllegalResumeEventError`, `AgentSnapshotVersionMismatchError`, and `AgentDecisionExhaustedError`.

Structural hashing cannot see custom function bodies or schema-validator implementations. Bump the machine's own `createMachine({ version })` whenever those semantics change, or pass an explicit `machineVersion` to `replay`. The per-entry hashes then verify the observable state and effect consequences.

## The store contract

`AgentEventLogStore` is an append-only protocol with optimistic concurrency on the log length.

```ts
import { createInMemoryEventLogStore, initEntry } from "@statelyai/agent";

const store = createInMemoryEventLogStore();
const entries = [initEntry(machine, input)];

// append at the expected position (0 = new thread); a concurrent writer
// with the same expectation loses with AgentEventLogConflictError
await store.append({ threadId: "session-1", expectedIndex: 0, entries });

// catch up incrementally
const recent = await store.read("session-1", { from: 3 });
const next = await store.length("session-1"); // the next expectedIndex
```

- `append` is atomic. It rejects stale writers with `AgentEventLogConflictError`, carrying `threadId`, `expectedIndex`, and `actualIndex`, the next index the store would accept, so two hosts resuming one thread resolve to exactly one winner. Event ids must be unique within a thread.
- `read` and `length` are the only read methods. Everything a host needs to know about a thread is derived from its entries.
- `fork({ threadId, newThreadId, upToIndex })` copies the prefix `[0, upToIndex)`. Omit `upToIndex` to copy the whole thread. Forked entries keep their ids. To diverge, append different envelopes to the new thread.

Every entry carries optional host-owned `metadata`, stored verbatim.

## SQLite stores

<!-- from src/sqlite/index.ts -->

`@statelyai/agent/sqlite` ships both durability stores on Node's built-in `node:sqlite`. It has no dependencies. It is Node-only and requires Node 22.18 or later.

- `createSqliteEventLogStore(options)` returns an `AgentEventLogStore` plus `close()`.
- `createSqliteSnapshotStore(options)` returns an `AgentSnapshotStore` plus `close()`.
- `options.database` is a file path to open, `':memory:'`, or an existing `node:sqlite` `DatabaseSync` handle. Both stores can share one handle.
- `close()` only closes a database the store opened itself. A handle you pass in stays yours to close.
- `options.tableName` defaults to `agent_event_log` and `agent_snapshots`. Tables are created on demand.

```ts no-check
import { DatabaseSync } from "node:sqlite";
import { createSqliteEventLogStore, createSqliteSnapshotStore } from "@statelyai/agent/sqlite";

const database = new DatabaseSync("./agent.db");
const events = createSqliteEventLogStore({ database });
const snapshots = createSqliteSnapshotStore({ database });

await events.append({ threadId: "session-1", expectedIndex: 0, entries });
await snapshots.save("session-1", snapshot);
```

`append` runs its length check and its inserts inside one `BEGIN IMMEDIATE` transaction. `node:sqlite` is synchronous, so nothing interleaves between the check and the write. Racing appends resolve to exactly one winner, and the loser gets `AgentEventLogConflictError`.

## Fork and diff

```ts
import { diffEventLogs } from "@statelyai/agent";

await store.fork({
  threadId: "session-1",
  newThreadId: "candidate",
  upToIndex: 8,
});

const diff = diffEventLogs(machine, await store.read("session-1"), await store.read("candidate"));
```

`diffEventLogs` returns the common prefix, the parent-only and fork-only tails, both replay results, JSON Patch-style logical-state changes, and added, removed, and changed frontier effects. The diff is structural only. To judge semantic quality, use an evaluator. See [Evals](evals.md).

<!-- viz: fork and diff: one thread's log forked at an index into a second thread, showing shared prefix and two divergent tails feeding diffEventLogs -->


## Store conformance

`createInMemoryEventLogStore()` is the reference implementation and the conformance baseline. An append-only log with a unique `(threadId, index)` constraint maps onto any database. Check that your store matches the reference on races, isolation, ordering, and fork semantics.

```ts
import { assertEventLogStoreConformance } from "@statelyai/agent";

await assertEventLogStoreConformance(() => createMyStore());
```

Each assertion throws a descriptive `Error` on the first violation, so any test runner or a plain script can drive it. The SQLite store passes the same suite.

## Resume precedence

<!-- log-first resume from src/run-agent.ts (options.events + replay + logIndex cache check); tests in src/run-agent.test.ts "log-first resume (snapshot as cache)" -->

When both `snapshot` and `events` are passed, which one wins depends on whether the log is self-contained.

- **Self-contained log.** The log is the source of truth. The snapshot is a cache of it and never overrides it.
- **No log, or a log that does not start at `@agent.init`.** The snapshot is the live resume source and the events are history only. This path is lossy: the run has no replayable history before the snapshot, so it cannot be replayed, verified, or forked. Prefer carrying the full log.

Every settled snapshot is stamped with `agentMeta.logIndex`, the length of the run's event log when it settled, and `agentMeta.logId`, that log's `executionId` — the lineage id pinned in its `@agent.init` entry's `metadata`. On the next resume, those two stamps decide how the cache is used.

- Trusted as-is, no replay: `logId` names the log being resumed, `logIndex` equals `events.length`, and the snapshot's state hash matches the tail entry's `verification.stateHash`. Length alone does not identify a prefix — a snapshot from a fork or a sibling thread can sit at the same index — so lineage and the tail hash are checked too.
- A log written before `metadata.executionId` existed has no `logId`, so its cache is never trusted without a replay.
- Everything else is untrusted: the log is replayed and the run resumes from the replayed state, not the snapshot. A snapshot stamped with a `logIndex` inside the log is still verified against the state the log's first `logIndex` entries replay to.
- A mismatch between those two states throws an `AgentError` with code `snapshot-diverged`. The two copies disagree about the same point in history, which is a bug rather than a resume. Drop the snapshot and resume from `events` alone if the log is the trustworthy copy.
- An unstamped snapshot carries no position, so there is nothing to verify against and the log wins.

The replay path carries the cache's message log (the working memory `getRequests` runs build) onto the replayed snapshot, since the event log does not record messages yet.

## Snapshots as compaction

[`AgentSnapshotStore`](human-in-the-loop.md) serves as an idle-point cache. At a quiescent point, meaning an idle state with no in-flight effects, persist the snapshot. A later run passes that snapshot alongside the log, and it is used as the cache described in [Resume precedence](#resume-precedence). Compact only at quiescent points. A snapshot taken mid-flight cannot carry in-flight effect state, but the log can.

## Related

- [The step path](steps.md): driving a machine one external input at a time, appending before continuing.
- [Human in the loop](human-in-the-loop.md): idle states, which are the compaction points.
- [Observability](observability.md): traces alongside the log, and `serializeTraceEvent` for JSONL output.
- [Hosts and executors](hosts.md): where a thread id and a store live in a real deployment.
