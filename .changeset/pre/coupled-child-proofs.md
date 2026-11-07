---
"@statelyai/agent": patch
---

`children: "coupled"` exploration closes two proof gaps:

- A `canReach` predicate and `dedupeBy` now see each coupled child's explored state through `snapshot.children[id].getSnapshot()`, not the state it started in. A parent's send and the child's receipt are one state, so cross-actor invariants can be targets.
- A coupled child's text requests deliver `@agent.usage` to the root, as a run does: each `usage` value forks a branch, and the root takes or drops the event by the usual rules. Token budgets fed by child calls can now be proved.
