---
"@statelyai/agent": minor
---

**`createAgentRun(machine, options)`**: a canonical run-stream handle over a single `runAgent` call. Returns `{ events, result }`:

- `events` is a single-consumer `AsyncIterableIterator<AgentTraceEvent>` that yields the run's trace events in `runAgent`'s emission order (`run.start` → request/chunk/transition/emit events → `run.end`) and completes once `run.end` is delivered. Events are buffered unboundedly, so a slow or absent consumer never blocks the run — `for await` over them, or await `result` first and drain them after.
- `result` is the same `Promise<RunAgentResult>` `runAgent` returns, with identical resolution/rejection behavior. A run-level failure still resolves with `{ status: 'error' }`; only `runAgent`'s bind-time programmer errors reject.

The run starts immediately (on the call, not on first iteration). A supplied `options.onTrace` is composed, not replaced — it still fires for every event. Options pass straight through, so resuming from a persisted `snapshot` (+ resume `event`) streams that run identically. Breaking out of `events` early stops delivery but does not cancel the run (`result` still settles); run cancellation is future work — pass `options.signal` to abort.
