---
"@statelyai/agent": minor
---

`wrapWorkflow({ id, effects, run })` wraps an existing async workflow, unchanged, as an agent machine: `running` invokes it, `done` carries its result. Each effect call is an `effect.call` then `effect.done` or `effect.error` event, so it shows in transitions, traces, and the event log. `wrapped.run(input, { effects, recorder, signal, ... })` returns what the workflow returned and rethrows what it threw; `recorder` records a golden run.

`checkParity({ scenarios, effects, before, after })` in `@statelyai/agent/testing` records `before` per scenario, replays `after` against the recording with no effect running, and compares them with `compareRecordings`. A throwing `after` is a report row, not a throw.
