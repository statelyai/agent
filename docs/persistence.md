# Persistence

The [event log](event-log.md) is the durable artifact. A snapshot is a cache over it.

- The log is an ordered array of the external inputs the machine received. A run is fully reconstructed from it.
- The persisted snapshot is the machine's serialized state at one point. It lets a resume skip the fold.
- Live run state — the actor, in-flight requests, stream chunks — is derived and disposable.

## Persist the log

Append entries as they happen through `onEvent`, or store `result.events` when the leg settles.

```ts no-check
const appended: AgentLogEntry[] = [];

const result = await runAgent(machine, {
  input,
  executors,
  onEvent: (entry) => appended.push(entry)
});

await store.append({ threadId, expectedIndex: appended[0].index, entries: appended });
```

`onEvent` is synchronous, so it buffers rather than awaits. Flush the buffer to the store as the leg settles, or on whatever cadence the host durability model needs.

`result.events` is a complete, self-contained segment: its first entry is the reserved `@agent.init` entry, so it replays with no side channel.

## Resume from the log

Pass `events` with no snapshot. `runAgent` folds the log and continues from there.

```ts no-check
const resumed = await runAgent(machine, {
  events: await store.read(threadId),
  event: { type: "APPROVE" },
  executors
});
```

- Recorded results are replayed, never re-executed.
- A request that was in flight when the log ended has no recorded completion, so it re-executes. Execution is at-least-once; key provider calls on [`info.callKey`](hosts.md#idempotency-keys).
- A log that already reached a final state settles immediately with the recorded output.
- The resumed result's `events` extends the same log, so the whole history stays replayable.

## Snapshot as cache

`persist()` output carries `agentMeta: { machineId, version, logId, logIndex }` — the lineage and position of the log it caches.

Pass `snapshot` alongside `events` to skip the fold:

```ts no-check
const resumed = await runAgent(machine, {
  events: await store.read(threadId),
  snapshot: await snapshots.get(threadId),
  event: { type: "APPROVE" },
  executors
});
```

- Fast path: `agentMeta.logId` names the log, `logIndex` equals the log length, and the snapshot's state hash matches the tail entry's `verification.stateHash`. Length alone is not enough — a fork or a sibling thread can sit at the same index.
- Otherwise the log is replayed and the run resumes from the replayed state.
- A cache that disagrees with the state the log replays to throws `AgentSnapshotDivergedError` (code `snapshot-diverged`). Drop the snapshot and resume from `events` alone.

A snapshot is never authoritative within a version. Snapshot only at quiescent points: a mid-flight snapshot cannot carry in-flight request state, but the log can.

Resuming from a snapshot with no log also yields a self-contained log — the new segment's init entry carries that snapshot — so every result is replayable.

## Version bridge

A log is truth within one `machine.version`. Across a version change, pass the old `events` together with a `snapshot`:

```ts no-check
const migrated = await runAgent(machine, {
  events: oldEntries,
  snapshot: oldSnapshot,
  executors
});
```

- XState's machine-owned `migrate` runs on the snapshot.
- The result is a **new** segment. Its init entry carries the migrated snapshot and `metadata.migratedFrom`.
- The old log stays as history under the old version. Keep it if you need to replay the past.
- Old `events` with no `snapshot` throw `AgentMachineVersionMismatchError`: there is nothing to migrate from.

Declare the version and migration on the machine:

```ts no-check
const machine = setup.createMachine({
  version: "2",
  migrate: (snapshot, fromVersion) =>
    fromVersion === "1"
      ? { ...snapshot, version: "2", context: upgrade(snapshot.context) }
      : snapshot,
  // ...
});
```

## Framework storage

Implement `AgentEventLogStore` against the host's database, or append through the framework's own mechanism: a Durable Object, workflow checkpoint, or server action store. See [Stores](event-log.md#stores) and [Hosts and executors](hosts.md).

The recipe per turn is the same everywhere: read the log, run, append what the run produced.

```ts no-check
const events = await store.read(threadId);
const appended: AgentLogEntry[] = [];

const result = await runAgent(machine, {
  events,
  event: incoming,
  executors,
  onEvent: (entry) => appended.push(entry)
});

await store.append({ threadId, expectedIndex: events.length, entries: appended });
```

The framework remains responsible for transactionality, retries, interruption recovery, and retention.
