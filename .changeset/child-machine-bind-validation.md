---
"@statelyai/agent": patch
---

`runAgent` now validates invoked child machines at bind time.

Previously, when a machine invoked a child machine whose own states invoke agent requests (`agent.generateText`, a named text request, or `agent.decide`) and that child request was left unbound, `runAgent` would not catch it at bind time — the run would settle in a wrong idle-looking state or fail mid-run instead of failing fast. The bind walk treated an invoked child machine as one opaque actor and never descended into its internal invokes.

The bind walk now recurses into invoked child state machines (arbitrarily deep, with a cycle guard for self-invoking machines). An unbound agent request inside a child machine throws a loud bind-time error naming the child invoke chain and the request `src`, with the fix spelled out. Child machine requests do **not** inherit the parent `runAgent`'s `generateText`/`streamText`/`decide` executors at runtime, so each child request must carry its own executor (`requestLogic.withExecutor(...)`) or be bound as a string-keyed source inside the child via nested `.provide`:

```ts
runAgent(parentMachine, {
  actorSources: {
    child: childMachine.provide({
      actorSources: { request: requestLogic.withExecutor(...) },
    }),
  },
});
```

Properly-bound children (the existing nested-`.provide` pattern) are unaffected.
