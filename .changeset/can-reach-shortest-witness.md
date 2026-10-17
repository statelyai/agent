---
"@statelyai/agent": patch
---

`canReach` now returns a shortest witness. It searches breadth first by path length, so the witness has the fewest events of any path within `maxDepth`, with each recorded invoke outcome (`xstate.done.actor.*`, `xstate.error.actor.*`) counted as one event. A retry loop no longer pads it. `complete` keeps its meaning, `dedupeBy` stays sound, and `explorePaths` still walks depth first with an unchanged report.
