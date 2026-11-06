---
"@statelyai/agent": patch
---

`explorePaths`/`canReach` with `children: "explore"`: a child's delivered parent events are keyed by its actor session, so a child restarted under the same id can deliver the same event again instead of being reported unreachable.
