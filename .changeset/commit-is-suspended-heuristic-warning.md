---
"@statelyai/agent": minor
---

**Committed the `isSuspended` option name (no longer provisional), and added a dev warning when a run falls back to the timing heuristic.**

```ts
await runAgent(machine, {
  input,
  executors,
  isSuspended: (snapshot) => snapshot.hasTag("waiting"),
});
```

Declare the predicate on `setupAgent({ isSuspended })` or per-run on `runAgent(machine, { isSuspended })`; the run-level option wins. When a run settles idle via the timing heuristic because neither was declared, `runAgent` now emits a one-time warning suggesting a deterministic predicate. No behavior change otherwise, and the warning is suppressed when `NODE_ENV === "production"`.
