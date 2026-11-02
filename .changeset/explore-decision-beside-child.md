---
"@statelyai/agent": patch
---

`explorePaths`/`canReach` with `children: "explore"`: a decision pending beside an explored child is no longer a false `needs-output`; its choices branch alongside the other pending settlements.
