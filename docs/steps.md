# The XState transition loop

Stately Agent requests are ordinary invoked actor logic. The underlying execution model is XState's transition/effect loop.

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

Use `runAgent` when an in-process actor is enough. Use `provideExecutors` when your application owns the live actor. Use `createDurable` from `xstate/durable` when a durable framework owns the effect lifecycle.

`executeAgentRequest(request, executors)` remains useful for evaluating or testing one individual model request without running a machine. It does not create a second state-machine runtime.

The host decides how effects execute. That includes retries, tool-loop interruption behavior, persistence, concurrency, and scheduling.
