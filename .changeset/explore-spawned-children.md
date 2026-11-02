---
"@statelyai/agent": patch
---

`explorePaths`/`canReach` with `children: "explore"` explore spawned child machines (`enq.spawn(actors.x, { id, input })`) with their spawn input, and fork the parent on each event a child sends it (`sendTo(parent, …)`). Pending explored children settle in any order.
