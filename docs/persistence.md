# Persistence

Stately Agent uses native XState snapshots. There is no Agent event-log format or storage adapter.

## Persist and resume

```ts no-check
const paused = await runAgent(machine, { input, executors });

if (paused.status === "idle") {
  await storage.put("run-42", paused.persist());
}

const snapshot = await storage.get("run-42");
const resumed = await runAgent(machine, {
  snapshot,
  event: { type: "APPROVE" },
  executors,
});
```

`result.snapshot` is the live typed snapshot for inspection. `result.persist()` is the XState persisted snapshot for serialization and later restoration.

## Versioning and migration

Use XState's machine-owned `version` and `migrate` fields:

```ts no-check
const machine = setup.createMachine({
  version: "2",
  migrate: (snapshot, fromVersion) => {
    if (fromVersion === "1") {
      return { ...snapshot, version: "2", context: upgrade(snapshot.context) };
    }
    return snapshot;
  },
  // ...
});
```

Without a compatible version or migration, XState restores an error snapshot. Stately Agent forwards that as `{ status: "error" }`; it does not stamp, rewrite, or interpret framework snapshots.

## Framework storage

Store the snapshot through the host framework's normal mechanism: a database, Durable Object, workflow checkpoint, server action store, or XState durable adapter. The framework remains responsible for transactionality, retries, interruption recovery, and retention.
