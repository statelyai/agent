---
"@statelyai/agent": patch
---

`canReach` without `dedupeBy` now deduplicates on a default key (state value, context, status, history, pending requests, children, armed timers, coupled children's states). An `interleave: "pending"` search that explored every interleaving now finishes, and a loop over finitely many states is a complete search. A step whose context is not plain data is not deduplicated. `explorePaths` is unchanged.
