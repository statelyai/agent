---
"@statelyai/agent": minor
---

`runAgent`'s executors now inherit down the whole actor tree.

Agent requests inside invoked child machines — at any depth — inherit the `generateText`/`streamText`/`decide` executors passed to `runAgent`, the same host-backed wrappers the top-level machine's own requests get. A child request participates in the run's `maxModelCalls` budget, `onTrace`, `onChunk`, and `onResult` exactly like a parent request. No per-child `.provide` ceremony is needed:

```ts
runAgent(parentMachine, { input, generateText }); // child requests inherit generateText
```

Rules:

- **Inheritance is the default** for any request reached through string-keyed actor sources (invoke `src` strings, registered `actorSources`), arbitrarily deep, cycle-safe.
- **Explicit bindings win.** A request that carries its own executor (`.withExecutor(...)`, `bindRequestExecutor(...)`, or a child's own `.provide({ actorSources })`) keeps it — the parent's executors are never called for it.
- **Missing executors still fail fast.** A reachable request whose required executor kind was not passed (e.g. a child stream request with no `streamText`) throws a loud bind-time error naming the invoke chain and the request `src`, before any actor runs.
- **Escape hatch.** Dynamically created logics (e.g. machine factories used with `enq.spawn`) and children invoked as direct-object `src` objects aren't reachable by the static bind walk; bind those explicitly with `bindRequestExecutor(...)` / `.withExecutor(...)`, or register the child as a string-keyed source.

This replaces the previous alpha behavior, where a child machine was treated as one opaque actor and an unbound child request threw a bind-time error demanding a nested `.provide`.
