---
"@statelyai/agent": minor
---

**`createAgentActor` (session mode), events-only resume, and machine `version` support.**

- **`createAgentActor(machine, options)`**: runAgent's engine with a session lifecycle. The live actor survives idle settles — `session.actor.send(event)` re-opens the cycle, `await session.settled()` resolves at the next quiescence — and every turn appends to one replayable event log with cumulative `session.usage()`. `runAgent` is now the one-shot wrapper over the same engine. See `examples/session-actor`.
- **Events-only resume (crash recovery)**: `runAgent(machine, { events })` with no snapshot derives the resume state from a self-contained log — recorded results replay (never re-execute), and a request that was in flight when the log ended re-executes idempotently on restore. See `examples/crash-recovery` and the event-log docs.
- **Machine `version` respected**: `machineVersion` now resolves as explicit option → the machine's own `createMachine({ version })` → structural hash, and the version gate also reads the XState persisted `version` field. After the gate decides (throw/warn/ignore/`migrateSnapshot`), the snapshot's `version` field is aligned before restore so XState's own mismatch throw never double-fires — a live `result.snapshot` JSON round-trip resumes cleanly under a versioned machine.
- **Executor correlation info**: text executors receive `info.runId` and `info.requestId` (the durable invoke id); decision requests carry `runId` alongside `signal`. Non-breaking; enables caching/rate-limit/span middleware as plain executor composition.
