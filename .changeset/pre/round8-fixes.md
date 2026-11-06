---
"@statelyai/agent": patch
---

- `wrapWorkflow` no longer freezes the caller's input: machine context holds its own copy of plain objects and arrays, and `run()` makes the workflow's own copy from the caller's input (an input that cannot be copied reaches it as is).
- `describeMachine` takes `helpers` and prints their source in a `Helpers` section. With `source: true`, it also prints entry and exit actions. It undoes vite SSR import rewrites.
- `explorePaths` and `canReach` path labels now use the v6 event shape `{ type: "xstate.done.actor" | "xstate.error.actor", actorId }`, not `xstate.done.actor.<id>`.
- `outputs: { src: [] }` marks a src that never settles: its invoke stays pending and the search explores events.
- `lintAgentMachine` takes `ignore: [{ code, path }]` to skip one check at one state.
- A replayed error's `name` is no longer an own enumerable property.
