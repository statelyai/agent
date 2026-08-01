---
"@statelyai/agent": minor
---

Added `matchesTrajectory`: the trajectory matcher for machine agents, exported from the root and dependency-free.

It compares a run's trajectory against an expected one as an ordered subsequence (gaps allowed, order enforced), with `{ exact: true }` for strict equality. Both trajectories may be state values from `onTransition` (strings, dot paths like `'review.editing'`, or the nested value XState reports) or events from `result.events` (`AgentLogEntry[]`, bare event objects, or event types), so one call scores either.

```ts
const path = matchesTrajectory(statePath, ["prompting", "drafting", "sent"]);
expect(path.matched, JSON.stringify(path.firstMiss)).toBe(true);

matchesTrajectory(result.events, ["PROMPT_SUBMITTED", { type: "MORE_INFO" }, "SEND"]);
```

The result serves tests and eval scorers alike: `matched`, `matchedCount`/`expectedCount`, a `score` (0..1) for partial credit, and a JSON-safe `firstMiss` of `{ index, expected, searchedFrom }` saying where the run diverged.
