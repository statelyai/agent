---
"@statelyai/agent": minor
---

**The event log is the source of truth for a run.** `runAgent` journals the root machine's external inputs as `AgentLogEntry` values, and a run resumes from that log.

- `result.events` is a complete, self-contained log segment: a reserved `@agent.init` entry (carrying `input` or a persisted `snapshot`, plus a per-lineage `metadata.executionId`), then every host event, child completion, timer, `@agent.usage`, and `agent.messages` event. Raised events are re-derived on replay.
- `onEvent(entry)` observes each entry as it is appended. `verification` (default on) stamps a per-entry `stateHash` from the live snapshot.
- `runAgent({ events })` resumes by replay. Recorded results are never re-executed; an in-flight request re-executes with the same `info.callKey`.
- A `snapshot` alongside the log is a cache: trusted when its `agentMeta` lineage id, index, and hash match the tail, otherwise the log wins. A diverged cache throws `AgentSnapshotDivergedError` (`snapshot-diverged`). `persist()` stamps `agentMeta: { machineId, version, logId, logIndex }`.
- Across a `machine.version` change, pass the old `events` and the migrated `snapshot`; the result starts a new segment whose init entry records `metadata.migratedFrom`. Old events without a snapshot throw `AgentMachineVersionMismatchError`.
- Snapshot-only resume also yields a replayable log.
- `@agent.usage` entries are always journaled; `result.usage` folds them via `getUsageFromEvents`. Delivery to the machine is still gated on a declared transition.
- Executors receive `info.callKey` (`<executionId>:<requestId>#<n>`), identical across crash re-execution, for provider and tool idempotency.
- New exports: `replay`, `forkEventLog`, `getLogExecutionId`, `getSnapshotStateHash`, `agentCallOccurrence`, `AgentEventLogStore`, `createInMemoryEventLogStore`, `assertEventLogStoreConformance`, `AgentEventLogConflictError`, `AgentReplayDivergenceError`, `AgentEventLogError`.
- Durability stays with the host. No durable runner and no SQLite subpath; the Cloudflare Durable Object example persists the journal in SQLite and drives each turn with `runAgent`.
