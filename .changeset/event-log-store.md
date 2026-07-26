---
"@statelyai/agent": minor
---

**`AgentEventLogStore`**: an append-only event log — the authoritative durability artifact for a thread. The journal of external inputs (effect completions, user-sent events, timer firings) IS the source of truth; deterministic machine replay derives every snapshot from it, a fork is a copied log prefix, and the type-only `AgentSnapshotStore` becomes a mere idle-point compaction cache over what the log already implies.

- `append({ threadId, expectedIndex, entries })` commits contiguous entries under optimistic concurrency: it rejects with `AgentEventLogConflictError` (carrying `threadId`, `expectedIndex`, `actualLength`) when a concurrent writer appended first, so two hosts racing on the same thread resolve to exactly one winner. `read(threadId, { from })` catches up incrementally, `length(threadId)` gives the next `expectedIndex`, and `fork({ threadId, newThreadId, upToIndex })` copies a log prefix onto a fresh thread for time travel or a divergent branch.
- `createInMemoryEventLogStore()` is a deep-copying reference implementation.
- `assertEventLogStoreConformance(create)` is a single-tier, runner-agnostic conformance suite that validates any store against the reference's semantics.
