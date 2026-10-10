---
"@statelyai/agent": minor
---

**Breaking: `runAgent` is replaced by a small loop you can run anywhere.**

`createAgentRuntime(machine, options)` returns the helpers for one run, built on XState's durable transition loop (`xstate/durable`):

```ts
const runtime = createAgentRuntime(machine, { executors });
let [state, effects] = await runtime.start({ input });
await runtime.execute(effects);
for (let event; (event = await runtime.nextEvent()); ) {
  [state, effects] = runtime.transition(state, event);
  await runtime.execute(effects);
}
const result = await runtime.finish(); // done | idle | error
```

`runToQuiescence(runtime, init)` is that loop as one call, for scripts and request handlers. Migrate `runAgent(machine, { executors, input, snapshot, event })` to `runToQuiescence(createAgentRuntime(machine, { executors }), { input, snapshot, event })`.

- `execute` only starts work. Every completion, child message and timer lands in one mailbox, and `nextEvent` hands out whichever arrived first, one event per transition.
- A run settles when nothing is in flight: no request, child or in-process timer still working. It no longer settles because a state looks idle.
- Root `after` timers run in-process by default. Pass `timers: { schedule, cancel }` to own them in a durable scheduler; the run then settles with the timer pending, and the host delivers `{ type: "xstate.timer", id }` (`AgentTimerEvent`) when it fires.
- Cancelling a run aborts its in-flight requests, and the persisted snapshot still resumes the work the cancel cut off.
- Bind-time errors (a missing executor, an unbound actor) throw from `createAgentRuntime` instead of rejecting a promise.
- Emitted events are reported after the transition that caused them.

Removed: `runAgent`, `runAgentStream`, `AgentStreamEvent`, the public step functions (`initialAgentStep`, `transitionAgentStep`, `resolveAgentStep`, `rejectAgentStep`, `executeAgentRequest`, `AgentStep`), `setupAgent({ isIdle })`, `fromConfig`'s `isIdle` option and the config's `idleTags`. `isAgentIdle` stays, to tell a human wait from a stuck machine once a run settles. Renamed: `RunAgentOptions` → `AgentRuntimeOptions` + `AgentRunInit`, `RunAgentResult` → `AgentRunResult`, `RunAgentErrorCause` → `AgentRunErrorCause`.
