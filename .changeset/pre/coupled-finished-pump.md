---
"@statelyai/agent": patch
---

`explorePaths` with `children: "coupled"` delivers a child machine's entry sends before its completion when the child is final at start, also when it is the only child.
