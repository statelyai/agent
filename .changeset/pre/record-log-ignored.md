---
"@statelyai/agent": patch
---

`recordLog` marks an entry `ignored: true` when the machine had no transition for an event sent to it, in the state the event arrived in. `xstate.*` events are never marked. A refused event can now be read from the log without a replay. `AgentLogEntry` gains the optional `ignored` field, and replay does not read it.
