---
"@statelyai/agent": patch
---

`AgentRuntime.send(event)` delivers a host event (a cancel, a user message) into a running run's mailbox: a parked `nextEvent()` resolves with it, and it is journaled and replayed like any other event. Returns `false` once the run stopped or the machine left `active`; throws `runtime-finished` after `finish`.
