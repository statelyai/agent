---
"@statelyai/agent": patch
---

`canReach` and `explorePaths` count a final child state as reached when its parent's `onDone` (or a parallel ancestor's) leaves it in the same step. Before, `canReach` reported such a state unreachable with `complete: true`.
