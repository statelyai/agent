---
"@statelyai/agent": minor
---

**`foldTraces` turns many runs into per-state stats.** From `@statelyai/agent/testing`: `foldTraces(traces, { failed })` takes one trace per run, live or serialized, and returns `{ state, visits, failures, withheld }` per state. Visits read `machine.transition`'s `from.value` and `snapshot.value`; `withheld` sums a decision's `request.withheld` from its first `request.start`.
