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

## Replaying a failed call

A call that failed is replayed as the invoke's error, not its output. Where a successful replay sends `xstate.done.actor` with the recorded output, a failed one sends `xstate.error.actor` with the recorded error, and the machine takes that invoke's `onError`. With no `onError` in scope the machine ends in `status: 'error'`, exactly as a live failed invoke does.

```ts no-check
const event = call.error
  ? { type: "xstate.error.actor", actorId: call.id, error: call.error }
  : { type: "xstate.done.actor", actorId: call.id, output: call.output };

[state, effects] = transition(machine, state, event);
```

The error value is whatever the host recorded. An `Error` is the usual one, and a plain object such as `{ code: "truncated" }` arrives at the `onError` transition as `event.error` untouched, so a machine can branch on a failure code.

Internally, `rejectAgentStep(machine, step, request, error)` is the step-envelope form of this, the failure counterpart of `resolveAgentStep`. `simulateAgent` uses it to script failures with no model. See [scripted failures](verify.md#scripted-failures).

The host decides how effects execute. That includes retries, tool-loop interruption behavior, persistence, concurrency, and scheduling.
