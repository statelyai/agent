---
"@statelyai/agent": minor
---

**`AgentEventLogStore`: the append-only event log is now the authoritative durability artifact.** The journal of external inputs (effect completions, user events, timer firings) is the source of truth; deterministic replay derives every snapshot from it, a fork is a copied log prefix, and the type-only `AgentSnapshotStore` becomes a mere idle-point compaction cache over what the log already implies.

```ts
const store = createInMemoryEventLogStore();
await store.append({ threadId: "t1", expectedIndex: 0, entries });
const next = await store.length("t1"); // the next expectedIndex
await store.fork({ threadId: "t1", newThreadId: "t1-branch", upToIndex: 1 });
const all = await store.read("t1", { from: 0 });
```

- `append({ threadId, expectedIndex, entries })` commits contiguous entries under optimistic concurrency, rejecting with `AgentEventLogConflictError` (carrying `threadId`, `expectedIndex`, `actualLength`) when a concurrent writer got there first — two hosts racing on one thread resolve to exactly one winner.
- `read(threadId, { from })` catches up incrementally, `length(threadId)` gives the next `expectedIndex`, and `fork({ threadId, newThreadId, upToIndex })` copies a prefix onto a fresh thread for time travel or a divergent branch (`atEventId` is the alternative, mutually exclusive cutoff).
- `createInMemoryEventLogStore()` is a deep-copying reference implementation.
- `assertEventLogStoreConformance(create)` is a single-tier, runner-agnostic conformance suite validating any store against the reference's semantics. See `@statelyai/agent/sqlite` for a durable one.
