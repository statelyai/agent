---
"@statelyai/agent": patch
---

An invoked child machine's `after` timers fire under `createAgentRuntime`. They were dropped as internal events sent from outside, so the child never moved. A run also no longer settles `idle` while a child timer is pending when `timers: { schedule, cancel }` is passed: child timers always run in process and count as work in flight.
