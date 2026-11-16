---
"@statelyai/agent": patch
---

`explorePaths` and `canReach` deliver the completion of a child machine whose initial state is final, with the child's own output, as a live run does. Before, the parent stayed `idle` in every `children` mode.
