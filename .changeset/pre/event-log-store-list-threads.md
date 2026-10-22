---
"@statelyai/agent": minor
---

**`AgentEventLogStore.listThreads`.** An optional store method, `listThreads({ prefix?, limit?, cursor? })`, returns `{ threadIds, cursor? }`: the threads holding at least one entry, paged by an opaque cursor. `createInMemoryEventLogStore()` implements it, and `assertEventLogStoreConformance` checks it only when a store has it, so existing stores keep compiling and passing.
