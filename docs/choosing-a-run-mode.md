# Choosing a run mode

The machine is the artifact. Runners only decide how one host executes its XState effects.

| Need                        | Use                                                                                 |
| --------------------------- | ----------------------------------------------------------------------------------- |
| One request/response run    | `runAgent`                                                                          |
| Several idle/resume turns   | `runAgent` in a `while` loop over `result.persist()`                                |
| Async progress feed         | `runAgentStream`                                                                    |
| A long-lived actor          | `provideExecutors` + XState `createActor`, see [Advanced](advanced.md)              |
| A custom or durable runtime | The step API, or `createDurable` from `xstate/durable`                              |

## Managed run

```ts no-check
const result = await runAgent(machine, { input, executors });

if (result.status === "idle") {
  await storage.save(result.persist());
}
```

`runAgent` binds Agent request executors and runs an ordinary XState actor until it is done, idle, or errors. It does not own storage, retries, or a durable journal.

## Idle/resume loop

```ts no-check
let result = await runAgent(machine, { input, executors });

while (result.status === "idle") {
  const snapshot = result.persist();
  await storage.save(snapshot);
  const event = await nextExternalEvent(result.snapshot);
  result = await runAgent(machine, { snapshot, event, executors });
}
```

The continuation is always the native persisted XState snapshot, so the loop can span processes: persist after one call, resume in another.

## Long-lived actor

When your application owns the actor, or the agent machine is a child in a larger XState system, bind the executors with `provideExecutors` and run a plain `createActor`. See [Advanced](advanced.md).

## The portable loop

Any host can run the same artifact with the pure step API. A step is the snapshot plus the model requests the machine is waiting on. Nothing executes until the host decides how:

```ts no-check
let step = initialAgentStep(machine, input);

while (!step.done) {
  const [request] = step.requests;
  if (!request) break; // idle: waiting on an external event
  if (request.kind === "decision") {
    const event = await resolveDecision(request, executors, { canTake: (e) => step.snapshot.can(e) });
    step = transitionAgentStep(machine, step, event);
  } else {
    const { result, messages } = await executeAgentRequest(request, executors);
    step = resolveAgentStep(machine, step, request, { result, messages });
  }
}

return step.snapshot.output;
```

See [The step API](steps.md).

[`portable-xstate-loop`](../examples/portable-xstate-loop) expands this sketch
into a runnable `createDurable` host. Its extra mailbox and wake-up plumbing is
host implementation, while the Agent machine artifact stays unchanged.

A durable host should use XState's `createDurable`. Its adapter owns persistence, retries, messaging, timers, and child execution. Stately Agent does not wrap those framework responsibilities.
