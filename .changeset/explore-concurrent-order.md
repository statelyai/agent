---
"@statelyai/agent": patch
---

`explorePaths` and `canReach` explore every settle order of concurrent work. When more than one invoke or text request is pending, each one can settle first, so a bug that needs one sibling to finish before another is reachable instead of reported unreachable with `complete: true`. Each order is a branch point that spends one level of `maxDepth`. Before, concurrent invokes settled in invoke-id order only, except beside an explored child.
