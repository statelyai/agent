---
"@statelyai/agent": minor
---

The AI SDK adapter now passes `maxRetries: 0` to every AI SDK call by default, so run usage counts every provider request. Set `maxRetries` in the adapter's `settings` or a model entry's settings to let the SDK retry; those retries are not counted in `modelCalls`.

A resume now checks the restored context against the machine's `context` schema and the `schemas.context` of each active state, with or without an event log. A context that fails throws `AgentSnapshotInvalidError` (code `snapshot-invalid`) before the run starts. The check runs each schema's validator on the stored values, so a context schema with a transform that changes a field's type rejects valid snapshots: declare context fields with the type they hold.
