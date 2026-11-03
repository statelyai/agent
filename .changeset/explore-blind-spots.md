---
"@statelyai/agent": patch
---

`explorePaths`/`canReach`: `interleave: "pending"` forks external events while an invoke is outstanding; `errors[src]` arrays fork one failing branch per value; `children: "explore"` explores invoked child machines and forks the parent on their distinct outputs and failures; the report's new `vacuous` lists event types whose payload-reading transitions were only tried as bare `{ type }`.
