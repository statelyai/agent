---
"@statelyai/agent": patch
---

`canReach`/`explorePaths`: a state the machine only passes through (an `always` hop or a `choice` state) now counts as reached. Before, `canReach` on such a state returned `{ reachable: false, complete: true }`, a false proof.
