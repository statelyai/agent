---
"@statelyai/agent": minor
---

**`metadata` stamps a run's log.** `createAgentRuntime` and `runAgent` take `metadata`, host-owned JSON stored on the log's `@agent.init` entry next to the reserved `executionId`: a policy version, model ids, a scenario. A resume keeps the first run's stamp. A value that is not JSON throws before the run starts.
