---
"@statelyai/agent": minor
---

**Scripted invoke failures.** `simulateAgent`, `explorePaths`, and `canReach` can now fail a request instead of resolving it, so a state that only an invoke's `onError` reaches is testable with no model and no keys.

A `SimulationScript` gains an `errors` channel, keyed by the same srcs as `text`/`invokes`/`decisions`. An entry is consumed before that src's output queue, so the first call fails and later calls fall through to the outputs as usual.

```ts
const result = await simulateAgent(machine, {
  script: {
    errors: { parse: [{ code: "truncated" }] },
    text: { parse: [{ total: 42 }] }, // still queued: the error was taken first
  },
});
// result.snapshot.value → the target of the `parse` invoke's onError
```

A failure value is any value. An `Error` is the usual one, and a plain object reaches the `onError` transition as `event.error` untouched, so a machine that branches on `event.error.code` needs no provider error class to test. An entry keyed by a decision src stands in for retry exhaustion. A rejection nothing catches errors the machine and throws, as a live run does.

Every `trail` entry's `resolvedRequest` now reports an `outcome` of `'output'` or `'error'`, and a rejected one carries the failure value on `error`.

`explorePaths` and `canReach` take a matching `errors` map of one canned failure per src. A src listed there forks an extra branch where the invoke is rejected — both branches when the src also has an output, the failing one alone when it does not. Each fork counts against `maxDepth`, and the failing branch records `{ type: 'xstate.error.actor.<id>' }` in the path, so a witness names the failure that got there.

```ts
const failure = await canReach(machine, "failed", {
  errors: { parse: new Error("truncated response") },
});
// failure.reachable → true; failure.witness → [{ type: 'xstate.error.actor.parse' }]
```
