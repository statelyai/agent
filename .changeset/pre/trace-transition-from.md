---
"@statelyai/agent": minor
---

**`machine.transition` traces carry `from`.** `from: { value: StateValue }` is the state value the event arrived in, emitted by `createAgentRuntime`/`runAgent` and by `traceTransitions`, and kept by `serializeTraceEvent`. The first transition of a stream (the init event, or a restore on resume) has no earlier state, so its `from.value` equals its `snapshot.value`.
