# The runtime loop

<!-- public AgentRuntime loop from src/run-agent.ts -->

`createAgentRuntime(machine, options)` binds executors and returns the operations
for one run. `runAgent` drives that loop until the machine finishes or no work
remains. Use the explicit loop when a host needs to persist, schedule, or observe
each transition itself.

```ts
import { createAgentRuntime } from "@statelyai/agent";

const runtime = createAgentRuntime(machine, { executors });
let [state, effects] = await runtime.start({ input });
await runtime.execute(effects);

for (let event; (event = await runtime.nextEvent());) {
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

Root `after` timers run in process by default. A pending in-process timer is
work in flight, so `runAgent` waits for it to fire and does not settle `idle`
while it is armed. A durable host can provide
`timers: { schedule, cancel }` to `createAgentRuntime` or `runAgent`. The run then
settles `idle` with the external timer pending. When it fires, deliver
`{ type: "xstate.timer", id }` through `transition` or as the `event` passed to
`runAgent`.

A resumed run calls `schedule` again for each timer still pending, with what is left of its delay by the wall clock. Treat `schedule` as an upsert by `id`: a host that already holds that timer keeps its own due time. An `id` names one arming: it includes the timer's occurrence, so a resumed run reuses the `id`, and re-entering the state schedules a new one. An `id` is unique within one run only. Two runs of the same machine can schedule the same `id`, so a host that stores timers for several runs keys them by the run's `executionId` (read it with `getLogExecutionId(entries)`, or use your own run id for a log written without one) and the `id`. A resume from the event log keeps the `executionId`; a resume from a snapshot alone starts a new lineage with a new one, so cancel the old run's stored timers when you resume that way. Keep the `id` from each `schedule` call and deliver that exact `id` to the run that scheduled it.

An invoked child machine's `after` timers always run in process, and the run
waits for them, whichever `timers` option you pass.

## Other hosts

- `runAgent(machine, options)` for scripts, tests, and request handlers.
- `provideExecutors` when an application owns a live XState actor.
- An explicit `AgentRuntime` loop when a workflow engine owns persistence,
  retries, messaging, timers, and child execution.

The machine artifact does not change between hosts.
