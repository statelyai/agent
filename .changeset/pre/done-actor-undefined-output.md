---
"@statelyai/agent": patch
---

**Void async actors journal.** An invoked `createAsyncLogic` actor whose `run` resolves `undefined` (or `null`, which XState's `data ?? output` coalesce turns into `undefined`) no longer makes the event log throw `NonSerializableAgentEventError` on its `xstate.done.actor` event. The journaled entry omits the `output` key instead; replay folds it identically.
