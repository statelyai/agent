---
"@statelyai/agent": minor
---

**`createAgentRun(machine, options)`: a run's trace events as an async stream.** Returns `{ events, result }` — the canonical handle for an SSE endpoint, a JSONL logger, or a progress UI.

```ts
const run = createAgentRun(machine, { input, executors });
for await (const event of run.events) {
  if (event.type === "request.end") console.log(event.type);
}
const result = await run.result;
```

- `events` is a single-consumer `AsyncIterableIterator<AgentTraceEvent>` yielding in `runAgent`'s emission order (`run.start` → request/chunk/transition/emit → `run.end`), completing once `run.end` is delivered. Buffered unboundedly, so a slow or absent consumer never blocks the run — iterate, or await `result` first and drain after.
- `result` is the same promise `runAgent` returns, with identical settle behavior: a run-level failure resolves `{ status: 'error' }`, and only bind-time programmer errors reject.
- The run starts on the call, not on first iteration. A supplied `options.onTrace` is composed, not replaced. Options pass straight through, so resuming from a persisted `snapshot` (+ resume `event`) streams that run identically.
- Breaking out of `events` early stops delivery but does not cancel the run (`result` still settles). Pass `options.signal` to abort.
