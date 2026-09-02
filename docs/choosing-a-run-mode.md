# Choosing a run mode

The machine is the artifact. Runners only decide how one host executes its XState effects.

| Need                        | Use                                                                                 |
| --------------------------- | ----------------------------------------------------------------------------------- |
| One request/response run    | `runAgent`                                                                          |
| Several idle/resume turns   | `runAgentLoop`                                                                      |
| Async progress feed         | `runAgentStream`                                                                    |
| A long-lived actor          | `provideExecutors` + XState `createActor`                                           |
| A custom or durable runtime | XState `initialTransition` / `transition`, or `createDurable` from `xstate/durable` |

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
const result = await runAgentLoop(machine, {
  input,
  executors,
  persist: (snapshot) => storage.save(snapshot),
  onIdle: async (idle) => nextExternalEvent(idle.snapshot),
});
```

The continuation is always the native persisted XState snapshot.

## Long-lived actor

```ts no-check
const bound = provideExecutors(machine, executors);
const actor = createActor(bound);
actor.start();
actor.send({ type: "USER_REPLIED", text: "Continue" });
```

## The portable loop

Any host can run the same artifact with XState's pure transition API:

```ts no-check
let [state, effects] = initialTransition(machine, input);
for (const effect of effects) await effect.exec();

while (state.status === "active") {
  const event = await nextEvent();
  [state, effects] = transition(machine, state, event);
  for (const effect of effects) await effect.exec();
}

return state.output;
```

[`portable-xstate-loop`](../examples/portable-xstate-loop) expands this sketch
into a runnable `createDurable` host. Its extra mailbox and wake-up plumbing is
host implementation, while the Agent machine artifact stays unchanged.

A durable host should use XState's `createDurable`. Its adapter owns persistence, retries, messaging, timers, and child execution. Stately Agent does not wrap those framework responsibilities.
