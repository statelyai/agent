---
"@statelyai/agent": minor
---

**`createAgentActor`: a long-lived agent session, plus events-only crash recovery.** The live actor survives idle settles, so a multi-turn conversation is one actor and one event log instead of a snapshot round-trip per turn.

```ts
const session = createAgentActor(machine, { input, executors });
await session.settled();          // resolves at the next quiescence
session.actor.send({ type: "SEND" }); // re-opens the cycle
await session.settled();
session.usage().totalTokens;      // cumulative across every turn
session.events;                   // one replayable log for the whole session
session.stop();
```

- **`createAgentActor(machine, options)`** is runAgent's engine with a session lifecycle; `runAgent` is now the one-shot wrapper over the same engine. See `examples/session-actor`.
- **Events-only resume**: `runAgent(machine, { events })` with no snapshot derives the resume state from a self-contained log. Recorded results replay rather than re-execute, and a request that was still in flight when the log ended re-executes idempotently on restore. See `examples/crash-recovery` and the event-log docs.
- **Machine `version` respected**: `machineVersion` resolves as explicit option → the machine's own `createMachine({ version })` → structural hash, and the version gate also reads XState's persisted `version` field. After the gate decides (`throw` / `warn` / `ignore`, or `migrateSnapshot`, which takes precedence), the snapshot's `version` is aligned before restore so XState's own mismatch throw never double-fires — a live `result.snapshot` JSON round-trip resumes cleanly under a versioned machine. The preset machines in `@statelyai/agent/machines` are the payoff (see that changeset).
- **Executor correlation**: text executors receive `info.runId` and `info.requestId` (the durable invoke id); decision requests carry `runId` alongside `signal`. Non-breaking, and it makes caching, rate-limit and span middleware plain executor composition.
