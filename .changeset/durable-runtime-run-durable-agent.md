---
"@statelyai/agent": minor
---

**`runDurableAgent`: run an agent machine on xstate's durable runtime.** Built on the new experimental `xstate/durable` entrypoint (`createDurable`), with the existing `AgentLogEntry` event log as the journal — journal in, run to `done`/`idle`, journal out. A resume folds the journal through pure transitions: an invoke whose completion is journaled is never re-started (recorded model calls never re-execute), while work in flight at a crash re-executes live.

```ts
const first = await runDurableAgent(machine, { input, executors });
// persist first.entries; later, in a new process:
const next = await runDurableAgent(machine, {
  entries: first.entries,
  event: { type: "APPROVE" },
  executors,
});
```

Requires `xstate@>=6.0.0-alpha.46` (peer range bumped). Executions pin a persisted `executionId`, so session ids are deterministic and journaled completions match replayed children natively. Also in the upgrade:

- Fixed cross-version snapshot resume under alpha.41: restored snapshots carry an own `machine` reference that made `runAgent`'s version-alignment path re-raise the mismatch it had just resolved.
- `snapshot._nodes` reads replaced with the now-public `snapshot.nodes`.
