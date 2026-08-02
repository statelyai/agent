---
"@statelyai/agent": minor
---

**`getAgentEffects` / `replay`: the two primitives over the append-only event log.** Fold a journal of external inputs through xstate's pure `initialTransition`/`transition` and the whole machine lifecycle — crash recovery, fork resume, time travel — becomes deterministic replay, because the journaled completion order IS the serialization.

```ts
const { snapshot, effects } = replay(machine, entries); // pure: executes nothing
for (const effect of effects) {
  if (effect.kind === "text") {
    const output = await executeAgentRequest(effect, executors);
    entries.push(createReplayEntry(machine, entries, effect.toDoneEvent(output)));
  }
}
```

- `getAgentEffects(machine, snapshot, actions, { history })` maps a transition's ORDERED executable actions — reconciled with the still-owed effects visible only on the snapshot — into an `AgentEffect[]` a host starts at the frontier. Kinds mirror what one transition can start: `text` / `decision` / `plan` (agent invokes), `task` (any other host-run invoke), `delay` (an `after(...)` timer), and `execute` (a fire-and-forget action — custom entry action, `sendTo`, `cancel` — run once, never journaled). Document order within a transition is preserved; snapshot-owed effects (a re-surfacing `agent.plan`, children spawned earlier and still pending) append after.
- Each `requestId` is `${siteId}#${n}`, `n` the 1-based occurrence derived from the journal (done AND error both count), so the same log yields identical requestIds on every replay.
- `text` and `task` effects carry `toDoneEvent(output)` / `toErrorEvent(error)`, which mint the exact `xstate.done.actor.<id>` / `xstate.error.actor.<id>` events xstate's actor system would deliver — pushing them into the journal and calling `transition` is indistinguishable from a live run.
- `replay(machine, entries, { input })` folds an `AgentLogEntry[]` WITHOUT executing anything and returns `{ snapshot, effects }`: the final snapshot plus the effects still owed at the frontier. Entries are validated with `assertAgentLogEntry`.
- `initEntry(machine, input?)` builds the reserved first journal entry (`{ type: '@agent.init', input }`) that makes a log self-contained. `replay` consumes it to recover the machine input with no side-channel, preferring it over an explicit `options.input`.
