# The runtime loop

<!-- public AgentRuntime loop from src/run-agent.ts -->

`createAgentRuntime(machine, options)` binds executors and returns the operations
for one run. `runToQuiescence(runtime, init)` drives that loop until the machine
finishes or no work remains. Use the explicit loop when a host needs to persist,
schedule, or observe each transition itself.

```ts
import { createAgentRuntime } from "@statelyai/agent";

const runtime = createAgentRuntime(machine, { executors });
let [state, effects] = await runtime.start({ input });
await runtime.execute(effects);

for (let event; (event = await runtime.nextEvent()); ) {
  [state, effects] = runtime.transition(state, event);
  await runtime.execute(effects);
}

const result = await runtime.finish();
```

- `start({ input | snapshot | events })` opens or resumes a run.
- `execute(effects)` starts work and returns when that work is accepted.
- `nextEvent()` returns the next completion, child message, or timer event. It
  returns `undefined` when the run is quiescent.
- `transition(state, event)` applies and journals one event.
- `finish()` stops remaining work and returns `done`, `idle`, or `error`.

Every state is a native XState snapshot. `result.persist()` returns plain JSON
for another process to resume with `start({ snapshot })`.

## Host-owned timers

Root `after` timers run in process by default. A durable host can provide
`timers: { schedule, cancel }` to `createAgentRuntime`. The runtime then settles
with an external timer pending. When it fires, deliver
`{ type: "xstate.timer", id }` through `transition` or as the `event` passed to
`runToQuiescence`.

## Other hosts

- `runToQuiescence(createAgentRuntime(...), init)` for scripts, tests, and
  request handlers.
- `provideExecutors` when an application owns a live XState actor.
- An explicit `AgentRuntime` loop when a workflow engine owns persistence,
  retries, messaging, timers, and child execution.

The machine artifact does not change between hosts.
