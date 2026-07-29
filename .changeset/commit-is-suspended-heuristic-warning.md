---
"@statelyai/agent": minor
---

Commit the `isSuspended` option name (no longer provisional). When a run settles idle via the timing heuristic because no suspension predicate was declared (neither `setupAgent({ isSuspended })` nor `runAgent(machine, { isSuspended })`), runAgent now emits a one-time dev warning suggesting a deterministic predicate such as `(s) => s.hasTag('waiting')`. No behavior change otherwise; suppressed when `NODE_ENV === "production"`.
