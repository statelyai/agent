---
"@statelyai/agent": patch
---

`explorePaths`/`canReach` with `children: "explore"`: while an explored child is pending, every pending text request, scripted invoke, and child settlement forks, so a child settling before a sibling invoke with an earlier id is explored instead of missed.
