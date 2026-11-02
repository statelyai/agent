---
"@statelyai/agent": patch
---

`explorePaths`/`canReach` with `children: "explore"`: an invoke or text request with no `outputs` entry, pending beside an explored child, now ends that branch `needs-output` instead of vanishing from the search, so the report is not complete.
