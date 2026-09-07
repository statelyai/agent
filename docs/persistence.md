# Persistence

The [event log](event-log.md) is the durable artifact. A snapshot is a cache over it.

- The log is an ordered array of the external inputs the machine received. A run is fully reconstructed from it.
- The persisted snapshot is the machine's serialized state at one point. It lets a resume skip the fold.
- Live run state — the actor, in-flight requests, stream chunks — is derived and disposable.

## Persist the log

Hand `runAgent` a [store](event-log.md#stores) and the thread it owns. Entries are written as they are accepted, and no model call runs against a log that is not yet durable.

```ts no-check
const result = await runAgent(machine, {
  input,
  store,
  threadId,
  executors
});
```

- A rejected write stops the run: `{ status: "error", cause: "journal" }`.
- `threadId` is required whenever `store` is given.

`onEvent` remains the observer seam — synchronous, never awaited. Persisting there is at-least-once: a crash between an entry and the host's flush loses it. See [Record a log](event-log.md#record-a-log).

`result.events` is a complete, self-contained segment: its first entry is the reserved `@agent.init` entry, so it replays with no side channel.

## Resume from the log

With a `store`, the thread's log is the resume: pass no `events` and no snapshot.

```ts no-check
const resumed = await runAgent(machine, {
  store,
  threadId,
  event: { type: "APPROVE" },
  executors
});
```

An empty thread starts fresh from `input`. Pass `events` explicitly to resume from a log the host holds itself (the store's thread length must then match it).

### Resume with an event off the wire

In a route handler the event arrives as JSON. Parse it at the boundary with `parseAgentEvent`, then pass the result as `event`:

```ts no-check
let event;
try {
  event = parseAgentEvent(machine, await request.json());
} catch (error) {
  return Response.json({ error: String(error) }, { status: 400 });
}

const result = await runAgent(machine, { store, threadId, event, executors });

if (result.ignored) {
  return Response.json(
    { error: `'${result.ignored.type}' does not apply right now` },
    { status: 409 }
  );
}
```

- `parseAgentEvent` takes `unknown`: hand over the parsed JSON body as-is. It accepts the machine itself (reading the event schemas `setupAgent` registered) or any snapshot of it, and returns the event typed as the machine's event union.
- It throws `AgentInvalidEventPayloadError` (code `invalid-event-payload`) when the payload is not an object with a string `type`, when the type is a reserved `@agent.*` type, or when the fields fail the registered schema. Answer that with a 400.
- On success the schema-parsed event is returned: defaults filled, transforms applied.
- `parseAgentEvent` does not check whether the current state handles the event, and `runAgent` adds no validation of its own.
- An event the resumed state has no transition for is ignored. The run settles normally and `result.ignored` carries the event. It is journaled like any other external input, so replay ignores it again.

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

The recipe per turn is one call: `runAgent` reads the thread, runs, and writes back.

```ts no-check
const result = await runAgent(machine, {
  store,
  threadId,
  event: incoming,
  executors
});
```

The framework remains responsible for transactionality, retries, interruption recovery, and retention.
