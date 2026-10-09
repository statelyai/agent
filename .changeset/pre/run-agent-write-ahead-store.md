---
"@statelyai/agent": minor
---

**`runAgent` can own the event log's durability.** Pass a store and a thread and the run reads its resume log from storage and writes every entry back, write-ahead.

```ts
const result = await runAgent(machine, {
  store,
  threadId: "session-1",
  input,
  executors,
});
```

- `store` (an `AgentEventLogStore`) plus `threadId` (required with it, `AgentError` code `missing-thread-id` otherwise). With no `events`, the thread's log is the resume — an empty thread starts fresh from `input`.
- Each entry is appended at its own `index` as `expectedIndex`, so a concurrent writer conflicts instead of interleaving.
- **Append-before-execute.** No text or decision call starts until every entry before it is durable; pure transitions never wait. The result resolves only once the run's writes have landed.
- A rejected write aborts in-flight work and settles `{ status: 'error', cause: 'journal' }` — a new `RunAgentErrorCause`. No further calls run.
- Passing `events` as well keeps that log as the resume, and the thread's length must match it.
- `onEvent` is unchanged: a synchronous observer, never awaited. Persisting there stays at-least-once; `store` is the write-ahead seam.
- `runAgentLoop` threads `store`/`threadId` through, reading the thread each turn instead of carrying the log itself.
