---
title: Where state lives
description: The two durable artifacts an agent run produces, what each one holds, and how to restore from them.
---

> **Alpha:** `@statelyai/agent` 2.0 is in alpha. APIs can change between releases; pin an exact version. Feedback: [github.com/statelyai/agent](https://github.com/statelyai/agent/issues).

This page describes what an agent run stores durably, where each artifact lives, and how to restore from it.

## Two durable artifacts

An agent run produces two artifacts worth writing to disk, plus run state that exists only while the process does.

- The **event log** is an ordered array of every external input the machine received. It is the only artifact a run can be fully reconstructed from.
- The **persisted snapshot** is the machine's serialized state at one quiescent point. It lets a resume skip replaying the log from index 0.
- In-memory run state is the live actor, in-flight effects, and stream chunks. It is derived and disposable. `runAgent` stops its actor on every settle path, so no durable artifact depends on it.

The log is the source of truth. A snapshot is a cache over the log and can be discarded at any time. When both are passed to `runAgent` and the log is self-contained, the log wins and the snapshot is verified against it. See [Resume precedence](event-log.md#resume-precedence).

<!-- viz: durability model: event log (append-only, source of truth) -> replay -> snapshot (cache at quiescent points) -> resume, with in-memory run state marked disposable -->


## The artifact table

The table covers the two durable artifacts plus the run state that is not durable. Messages and stores are not artifacts and are described after it.

| Artifact                                  | What it holds                                                                                                                                                                                                          | When written                                                                       | Survives                                                                                     | Restore with                                                                    | Full guide                                                                    |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| **Event log entries** (`AgentLogEntry[]`) | One envelope per external input: the `@agent.init` event, effect completions and errors with outputs inline, externally sent events, timer firings, plus identity, timestamp, machine version, and verification hashes | Per accepted external input, via `result.events`, `onEvent`, or a step-path append | Process death, redeploy, machine-version change, forking | `replay(machine, entries)`, or `runAgent(machine, { events })` with no snapshot | [The event log](event-log.md)                                                 |
| **Persisted snapshot**                    | The machine's serialized state at a quiescent point: state value, context, restored pending invokes, and the `agentMeta.logId`/`logIndex` log position it caches                                                                   | At a settle point (`result.snapshot`) or from an actor's `getPersistedSnapshot()`  | Process death, redeploy, days of waiting                                                     | `runAgent(machine, { snapshot, event })`, alongside `events` where a log exists  | [Human in the loop](human-in-the-loop.md#persist-and-resume-across-processes) |
| **In-flight effect state**                | Which model calls are owed right now                                                                                                                                                                                   | Not written directly. It is implied by the log's recorded completions              | Process death, through the log only. A mid-flight snapshot cannot carry it                   | `replay`, which re-derives owed effects including still-owed dynamic spawns     | [The step path](steps.md#crash-recovery-and-resume)                           |

Messages and any other accumulated data live in machine `context`, so they ride inside both artifacts. There is nothing separate to store or restore. See [Messages](messages.md).

Stores are where the two artifacts land. See [Stores](#stores) below.

Two rules follow from the table:

- Snapshot only at quiescent points. A mid-flight snapshot cannot carry in-flight effect state, but the log can. Compact at idle, then resume by passing the snapshot alongside the entries appended since. A snapshot behind the log's tail is verified against the log and the log is replayed.
- Resume from a snapshot alone only when there is no log. That path cannot be replayed, verified, or forked.
- Keep context JSON-serializable. Both artifacts round-trip through `JSON.stringify`. Keep sessions, database clients, and sockets in closures, and store only their ids.

## Stores

Two store protocols are defined as interfaces, so a userland store interoperates with the library.

- `AgentEventLogStore` is append-only with optimistic concurrency on log length. It has `append({ threadId, expectedIndex, entries })`, `read`, `length`, and `fork`. A stale writer fails with `AgentEventLogConflictError`. See [the store contract](event-log.md#the-store-contract).
- `AgentSnapshotStore` has `load(id)` and `save(id, snapshot)`. It is a key-to-JSON upsert.

Shipped implementations:

| Store               | Import                                                                   | Notes                                                         |
| ------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------- |
| In-memory event log | `createInMemoryEventLogStore()` from `@statelyai/agent`                  | The reference implementation and conformance baseline         |
| SQLite event log    | `createSqliteEventLogStore({ database })` from `@statelyai/agent/sqlite` | Node's built-in `node:sqlite`, no dependencies, Node >= 22.18 |
| SQLite snapshots    | `createSqliteSnapshotStore({ database })` from `@statelyai/agent/sqlite` | Shares one `DatabaseSync` handle with the event log store     |

Both SQLite stores take a file path, `':memory:'`, or an existing handle. They create their tables on demand. Postgres and Redis adapters are [on the roadmap](roadmap.md) and are not shipped. To use another database, write a store against the protocol and check it with `assertEventLogStoreConformance`.

## Recipes

Each recipe is written up in full on its owning page.

- Crash recovery: resume from the log alone. Recorded model calls are replayed instead of re-executed. See [log-only resume](event-log.md#log-only-resume-crash-recovery) and [append before continue](steps.md#durable-append-before-continue).
- Resume with an event: run to idle, store the snapshot, then load it later and deliver the human's event. See [persist and resume across processes](human-in-the-loop.md#persist-and-resume-across-processes).
- Time travel: `replay(machine, entries.slice(0, n))` rebuilds the state as of any point in the log without executing anything. See [crash recovery and resume](steps.md#crash-recovery-and-resume).
- Fork and branch: `store.fork({ threadId, newThreadId, upToIndex })` copies the prefix `[0, upToIndex)` onto a new thread. `diffEventLogs` reports what diverged. See [fork and diff](event-log.md#fork-and-diff).
- Verify a log: `replay(machine, entries, { verify: 'strict' })` requires verification hashes on every entry and fails at the first mismatch. See [strict replay verification](event-log.md#strict-replay-verification).

Runnable versions: [crash-recovery](../examples/crash-recovery/index.ts) and [time-travel](../examples/time-travel/index.ts) for the log recipes, [file-snapshot-store](../examples/file-snapshot-store/index.ts) for a store written against `AgentSnapshotStore`, [session-actor](../examples/session-actor/index.ts) for one live actor across turns on a single log, and [snapshot-migration](../examples/snapshot-migration/index.ts) for resuming a paused run after the machine was redeployed.

## Related

- [The event log](event-log.md): the log envelope, the JSON wire contract, and the SQLite stores.
- [Human in the loop](human-in-the-loop.md): idle states, which are the compaction points.
- [The step path](steps.md): owning the loop and persisting between model calls.
- [Choosing a run mode](choosing-a-run-mode.md): which artifacts each mode produces by default.
