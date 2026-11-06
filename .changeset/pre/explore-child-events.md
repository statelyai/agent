---
"@statelyai/agent": patch
---

`explorePaths`/`canReach` with `children: "explore"` offers an invoked child only the events `childEvents[src]` lists (the ones the parent forwards); a child wait for an unlisted event leaves the search incomplete instead of reporting the child's finals as reachable.
