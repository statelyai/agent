---
"@statelyai/agent": minor
---

Versioned trace schema, shared identically across the controlled and uncontrolled paths:

- **`schemaVersion`.** Every `onTrace` event now carries `schemaVersion` (currently `1`), exported as the const `AGENT_TRACE_SCHEMA_VERSION`. Consumers can gate on it.
- **`onTrace` for `provideExecutors`.** `ProvideExecutorsOptions` gains `onTrace`, emitting request-level events (`request.start`, `request.end` incl. lifted `reasoning`, `request.error`, `stream.chunk`) with shapes identical to `runAgent`. Because one bound machine can back many concurrent root actors, envelope state (`runId`, monotonic `seq`) is minted per root actor at runtime — two concurrent actors get distinct `runId`s and independent `seq`.
- **`traceTransitions(onTrace)`.** New exported xstate `inspect` handler that emits `machine.transition` trace events sharing the same versioned envelope and per-root-actor `seq` registry, so pairing it with `provideExecutors`' `onTrace` yields one ordered stream. The uncontrolled path has no `run.start`/`run.end` (no run boundary) by design.
