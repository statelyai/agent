---
title: Where state lives
description: The two durable artifacts an agent run produces, what each one holds, and how to restore from them.
---

> **Alpha:** `@statelyai/agent` 2.0 is in alpha. APIs can change between releases; pin an exact version. Feedback: [github.com/statelyai/agent](https://github.com/statelyai/agent/issues).

## Two durable artifacts

An agent run produces exactly two things worth writing to disk, plus run state that only exists while the process does.

- **The event log** is the authoritative journal: an ordered array of every external input the machine received, and the only artifact from which the run can be fully reconstructed.
- **The persisted snapshot** is a compaction cache: the machine's serialized state at one quiescent point, so a resume can skip replaying the log from index 0.
- **In-memory run state** (the live actor, in-flight effects, stream chunks) is derived and disposable; `runAgent` stops its actor on every settle path, so nothing durable ever depends on it.

The log is the source of truth. A snapshot is an optimization over it, and can always be thrown away.

## The artifact table

| Artifact                                  | What it holds                                                                                                                                                                                                          | When written                                                                       | Survives                                                                                     | Restore with                                                                    | Full guide                                                                    |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| **Event log entries** (`AgentLogEntry[]`) | One envelope per external input: the `@agent.init` event, effect completions and errors with outputs inline, externally sent events, timer firings, plus identity, timestamp, machine version, and verification hashes | Per accepted external input, via `result.events`, `onEvent`, or a step-path append | Process death, redeploy, machine-version change (with an explicit `machineVersion`), forking | `replay(machine, entries)`, or `runAgent(machine, { events })` with no snapshot | [The event log](event-log.md)                                                 |
| **Persisted snapshot**                    | The machine's serialized state at a quiescent point: state value, context, and restored pending invokes                                                                                                                | At a settle point (`result.snapshot`) or from an actor's `getPersistedSnapshot()`  | Process death, redeploy, days of waiting                                                     | `runAgent(machine, { snapshot, event })`                                        | [Human in the loop](human-in-the-loop.md#persist-and-resume-across-processes) |
| **Messages and context**                  | Conversation history and any accumulated data live in machine `context`, so they ride inside both artifacts. Nothing separate to store                                                                                 | With whichever artifact you write                                                  | Same as its carrier                                                                          | Restoring either artifact                                                       | [Messages](messages.md)                                                       |
| **In-flight effect state**                | Which model calls are owed right now                                                                                                                                                                                   | Never snapshot-able mid-flight                                                     | Only the log survives this                                                                   | `replay`, which re-derives owed effects including still-owed dynamic spawns     | [The step path](steps.md#crash-recovery-and-resume)                           |
| **Stores**                                | Where the two artifacts land                                                                                                                                                                                           | On `append` / `save`                                                               | Whatever the backing database does                                                           | `store.read(threadId)` / `store.load(id)`                                       | [Stores](#stores)                                                             |

Two rules follow from the table:

- **Snapshot only at quiescent points.** A mid-flight snapshot cannot carry in-flight effect state; the log can. Compact at idle, resume from the snapshot plus the entries appended since.
- **Context must be JSON-serializable.** Both artifacts round-trip through `JSON.stringify`. Keep sessions, db clients, and sockets in closures and store only their ids.

## Stores

Two protocols, both `interface`-first so a userland store interoperates:

- **`AgentEventLogStore`**: append-only with optimistic concurrency on log length. `append({ threadId, expectedIndex, entries })`, `read`, `length`, `fork`. A stale writer loses with `AgentEventLogConflictError`. See [the store contract](event-log.md#the-store-contract).
- **`AgentSnapshotStore`**: `load(id)` / `save(id, snapshot)`. A key-to-JSON upsert.

Shipped implementations:

| Store               | Import                                                                   | Notes                                                         |
| ------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------- |
| In-memory event log | `createInMemoryEventLogStore()` from `@statelyai/agent`                  | The reference implementation and conformance baseline         |
| SQLite event log    | `createSqliteEventLogStore({ database })` from `@statelyai/agent/sqlite` | Node's built-in `node:sqlite`, no dependencies, Node >= 22.18 |
| SQLite snapshots    | `createSqliteSnapshotStore({ database })` from `@statelyai/agent/sqlite` | Shares one `DatabaseSync` handle with the event log store     |

Both SQLite stores take a file path, `':memory:'`, or an existing handle, and create their tables on demand. Postgres and Redis adapters are [on the roadmap](roadmap.md), not shipped; write your own against the protocol and prove it with `assertEventLogStoreConformance`.

## Recipes

Each of these is written up in full on its owning page:

- **Crash recovery**: resume from the log alone, with recorded model calls replayed rather than re-billed. See [log-only resume](event-log.md#log-only-resume-crash-recovery), and [append before continue](steps.md#durable-append-before-continue) for the step-path guarantee.
- **Resume with an event (human in the loop)**: run to idle, store the snapshot, load it later and deliver the human's event. See [persist and resume across processes](human-in-the-loop.md#persist-and-resume-across-processes).
- **Time travel**: `replay(machine, entries.slice(0, n))` rebuilds the state as of any point in the log, without executing anything. See [crash recovery and resume](steps.md#crash-recovery-and-resume).
- **Fork and branch**: `store.fork({ threadId, newThreadId, atEventId })` copies a prefix onto a new thread; `diffEventLogs` reports what diverged. See [fork and diff](event-log.md#fork-and-diff).
- **Verify a log**: `verifyReplay` requires verification hashes on every entry and fails at the first mismatch. See [strict replay verification](event-log.md#strict-replay-verification).

## Related

- [The event log](event-log.md): the durability hub, the JSON wire contract, and the SQLite stores in detail.
- [Human in the loop](human-in-the-loop.md): idle states, the natural compaction points.
- [The step path](steps.md): owning the loop and persisting between model calls.
- [Choosing a run mode](choosing-a-run-mode.md): which artifacts each mode gives you by default.
