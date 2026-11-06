---
"@statelyai/agent": patch
---

Fixes from greenfield trials:

- `runAgent` with `onIdle` keeps one inspector root across passes (the root and persisted children keep their handles), and `signal` now aborts a run parked in `onIdle`; `onIdle` receives `{ signal }`.
- Resuming with host-owned timers no longer throws `AgentSnapshotDivergedError`: a timer's wall-clock `scheduledAt` is left out of the snapshot hash.
- A request that fails inside a child machine reaches the child's `onError` instead of settling the run idle.
- A plain actor inside a child machine starts only after the child's earlier log entries are durable, so a resume no longer re-runs a completed tool.
- A request's `@agent.usage` inside a child reaches the root before the child's completion, so budget handlers see concurrent children's spend.
- `explorePaths` and `canReach` fire armed timers (`after`, `timeout`, delayed raises) as events instead of reporting a timer-gated search complete; `timers: "ignore"` restores the old behavior with the result marked incomplete. New `usage` option delivers `@agent.usage` before a root text request settles. A src provided as a plain actor is explored as one, even when registered as a request. New `textOutput(result, { messages })` canned output for machines that read `output.messages`.
