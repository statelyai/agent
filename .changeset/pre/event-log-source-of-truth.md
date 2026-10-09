---
"@statelyai/agent": minor
---

Add the event log as the source of truth for a run; a snapshot is a verified cache over it.

- `runAgent` journals the root machine's external inputs as `AgentLogEntry` values: the reserved `@agent.init` entry, host events, child completions, timers, `@agent.usage`, and `agent.messages`. `result.events` is a complete, self-contained log; `onEvent` delivers each entry as it is appended; `verification` (default on) stamps a per-entry state hash computed from the live snapshot.
- `runAgent({ events })` resumes by replaying the log. Recorded results are reused, never re-executed; a request that was in flight re-executes with the same `info.callKey`. A `snapshot` passed alongside the log is trusted only when its `agentMeta` lineage id, index, and hash match the log's tail; otherwise the log wins, and a diverged cache throws `AgentSnapshotDivergedError`.
- Across a `machine.version` change, pass the old `events` and the migrated `snapshot`; the result starts a new log segment whose init entry carries the snapshot and `metadata.migratedFrom`. Old events without a snapshot throw `AgentMachineVersionMismatchError`.
- Every `@agent.usage` event is journaled as a spend record whether or not the machine handles it; `result.usage` folds the log (`getUsageFromEvents`).
- Executors receive `info.callKey`, a deterministic per-call idempotency key (`<executionId>:<requestId>#<n>`).
- New exports: `replay`, `forkEventLog`, `initEntry`, `createReplayEntry`, `validateReplayEntries`, `getLogExecutionId`, `getSnapshotStateHash`, `agentCallOccurrence`, `rebindActorSession`, `AgentEventLogStore`, `createInMemoryEventLogStore`, `assertEventLogStoreConformance`, `AgentEventLogConflictError`, `AgentReplayDivergenceError`, `AgentEventLogError`, `NonSerializableAgentEventError`.
- Durability stays with the host. The Cloudflare Durable Object example persists the journal in SQLite through the store interface and drives each turn with `runAgent`.
