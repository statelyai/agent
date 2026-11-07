---
"@statelyai/agent": patch
---

Add `checkCrashRecovery` to `@statelyai/agent/testing`: it kills a durable run after every log append and while every effect is in flight, resumes each from the store's log, and checks the resume against an uninterrupted run (no durable effect re-runs, none skipped, same `callKey` and request, same outcome, the log replays). Pass `store` to check your own store adapter.

Fix: a child machine that finished just before a crash (its last entry journaled, its parent's `xstate.done.actor` not yet) no longer leaves the resumed parent waiting forever. The restored child's completion is now delivered to its parent, at any depth.

`@agent.usage` now carries the call's `callKey`.

Fix: a parent's `sendTo` into a journaled child machine, and the child's reply, are no longer lost when the run dies between appends. The store now receives every entry since the loop last waited in one atomic append (`expectedIndex` is the batch's first index), so an event and the child inputs it caused land together.
