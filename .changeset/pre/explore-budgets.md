---
"@statelyai/agent": patch
---

`explorePaths`/`canReach`: new `budget: { nodes?, ms?, childCache? }` bounds the whole call, child searches (`children: "explore"`) included; `budget.nodes` defaults to 250,000. An exhausted budget stops the search cleanly with a `budget-exhausted: nodes` or `budget-exhausted: ms` note; the report's new `partial` and `complete` flags say so, and `canReach` returns `complete: false`; `verifyAgentConfig` fails its explore gate with the note. Explored-child outcomes are kept in a bounded LRU cache, and a search keeps one parent pointer per node instead of a path copy, so long searches retain far less memory.
