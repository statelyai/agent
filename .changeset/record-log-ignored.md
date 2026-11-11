---
"@statelyai/agent": patch
---

`recordLog` marks an entry `ignored: true` when the machine had no transition for the event in the state it arrived in. A refused event can now be read from the log without a replay. `AgentLogEntry` gains the optional `ignored` field, and replay does not read it.
