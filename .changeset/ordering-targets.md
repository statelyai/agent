---
"@statelyai/agent": patch
---

`explorePaths({ steps: true })` records every macrostep on each terminal, with the srcs each step started and settled. `canReach` takes an ordering target, `{ after, reach }`, to prove that something never happens after a trigger ("no turn starts after STOP"). The trigger is part of the `dedupeBy` key, so the proof stays sound.
