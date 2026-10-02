---
"@statelyai/agent": patch
---

Restore agent runs with XState's `execution.restore()` instead of sending a
synthetic machine event, so wildcard transitions are not triggered during
restoration and in-flight children and pending timers resume through the
durable adapter. Preserve timer deadlines and stop in-flight child requests
through XState's public runtime API. Require XState `6.0.0-alpha.63` (pinned
while its experimental durable APIs evolve).
