---
"@statelyai/agent": minor
---

The event log is the source of truth everywhere; a snapshot is a verified cache.

- `runAgent`: a self-contained `events` log always drives resume. A `snapshot` passed alongside it is trusted only when its new `agentMeta.logIndex` equals the log length; otherwise the log is replayed and a diverged snapshot throws `AgentSnapshotDivergedError` (`snapshot-diverged`). Resuming a log that already reached a final state now settles instead of hanging.
- Every `@agent.usage` event is journaled, whether or not the machine declares a transition for it. `result.usage` is a fold over the log (new root export `getUsageFromEvents`); stragglers append after settle and reach `onEvent`.
- `runDurableAgent`: replay-verification hashes are computed per entry from the live fold (O(1)) and on by default (`verification: false` opts out); resume replays the journal in strict mode. Journaled child completions are rebound to the current fold's children, fixing resume from a journal written by another process. Idle no longer surfaces as an unhandled rejection. `onEntry(entry, snapshot)` receives the live snapshot.
- Executors receive `info.callKey`, a deterministic per-call idempotency key (`<logId>:<siteId>#<n>`) that is identical across crash re-execution on both `runAgent` and `runDurableAgent`; `provideExecutors({ callKey })` lets other hosts supply a minter.
- The Cloudflare example persists an append-only journal in Durable Object SQLite instead of snapshots.
