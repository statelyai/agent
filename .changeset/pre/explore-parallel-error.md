---
"@statelyai/agent": patch
---

`explorePaths` and `canReach` end a path in an `error` terminal when an invoke in one region of a parallel state rejects with no `onError` in scope, as a live actor errors. Before, the search kept settling the other regions' invokes on the errored snapshot, so the same `xstate.done.actor` repeated until the path ended `max-depth` and `canReach` reported the search incomplete.
