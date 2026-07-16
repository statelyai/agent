---
"@statelyai/agent": minor
---

Trace events and live message emissions now carry the run's machine identity:

- **Trace envelope.** Every `onTrace` event now carries `machineId` and `machineVersion` alongside `runId`, `seq`, and `timestamp` — the same identity stamped onto settled snapshots as `agentMeta`.
- **`onMessage` info arg.** `onMessage` now receives a second argument, `info: AgentMessageInfo` (`{ runId, machineId, machineVersion }`). The message objects themselves are unchanged (they stay clean model input); the identity travels on the info arg. Existing one-argument handlers keep working.
- New exported types `AgentRunMeta` (the snapshot stamp's shape) and `AgentMessageInfo`.
