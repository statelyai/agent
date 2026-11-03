---
"@statelyai/agent": patch
---

`runAgent` takes an `inbox` from `createAgentInbox()`: `inbox.send(event)` delivers host events mid-run (a cancel, a user message) with `AgentRuntime.send`'s result, queues before start, and resumes an idle run ahead of a pending `onIdle` answer.
