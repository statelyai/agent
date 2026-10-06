# Choosing a run mode

The machine is the artifact. Runners only decide how one host executes its XState effects.

| Need                             | Use                                                                    |
| -------------------------------- | ---------------------------------------------------------------------- |
| One request/response run         | `runToQuiescence(createAgentRuntime(...), init)`                       |
| Several idle/resume turns        | `runToQuiescence` in a loop over `result.persist()`                    |
| Transition-by-transition control | The explicit `AgentRuntime` loop                                       |
| A long-lived actor               | `provideExecutors` + XState `createActor`, see [Advanced](advanced.md) |

## Managed run

```ts no-check
const result = await runToQuiescence(createAgentRuntime(machine, { executors }), { input });

if (result.status === "idle") {
  await storage.save(result.persist());
}
```

`createAgentRuntime` binds request executors. `runToQuiescence` drives its durable
transition loop until the run is done, idle, or errors. Storage remains host-owned.

## Idle/resume loop

```ts no-check
let result = await runToQuiescence(createAgentRuntime(machine, { executors }), { input });

while (result.status === "idle") {
  const snapshot = result.persist();
  await storage.save(snapshot);
  const event = await nextExternalEvent(result.snapshot);
  result = await runToQuiescence(createAgentRuntime(machine, { executors }), { snapshot, event });
}
```

The continuation is always the native persisted XState snapshot, so the loop can span processes: persist after one call, resume in another.

## Long-lived actor

When your application owns the actor, or the agent machine is a child in a larger XState system, bind the executors with `provideExecutors` and run a plain `createActor`. See [Advanced](advanced.md).

## The portable loop

Any host can drive `AgentRuntime` one transition at a time. Effects only start
when the host calls `execute`; completions and child messages arrive through
`nextEvent`. See [The runtime loop](steps.md).

[`portable-xstate-loop`](../examples/portable-xstate-loop) expands this sketch
into a runnable `createDurable` host. Its extra mailbox and wake-up plumbing is
host implementation, while the Agent machine artifact stays unchanged.

A durable host owns persistence, retries, messaging, timers, and child execution.
Stately Agent does not wrap those framework responsibilities.
