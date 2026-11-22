---
"@statelyai/agent": patch
---

**Breaking:** `explorePaths` and `canReach` no longer take `maxNodes`. `budget.nodes` is the one cap on branch points expanded, counted across the whole call, child searches included (default 250,000). Replace `maxNodes: n` with `budget: { nodes: n }`. The two options counted the same branch points; `maxNodes` only scoped the count to each search. A search the node cap cuts short is now reported as `partial` with a `budget-exhausted: nodes` note in `unexplored`, not with `hitPathCap`, which now means `maxPaths` only. A top-level search with no explored children now stops at 250,000 branch points by default instead of 100,000. `verifyAgentConfig`'s `explore` gate names the path cap as `the path cap (maxPaths n)`.
