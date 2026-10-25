---
"@statelyai/agent": patch
---

**A fork is its own lineage.** `forkEventLog` and `store.fork` give the fork's init entry a fresh `metadata.executionId` and `metadata.forkedFrom: { executionId?, logIndex }` (the parent's id, when it has one, and the cutoff). Before, a fork kept its parent's execution id, so a call the fork made at the same site got the same `info.callKey` as the parent's, and a cache keyed on it could return the parent's result.

- **A custom store's `fork` must store what `forkEventLog` returns** for the prefix. `assertEventLogStoreConformance` now checks the lineage, and its fixtures start with a real init entry.
- A snapshot taken on the parent no longer takes the fast path when resuming the fork; the fork's log is folded instead. A version bridge still accepts it while the fork has appended nothing since its cutoff.
- Explicit `events` for a stored thread must also match its init entry's `executionId`, so a parent's log is refused for its fork's thread.
