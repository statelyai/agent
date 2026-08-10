---
"@statelyai/agent": minor
---

`setupAgent.fromConfig(...)` machines can now declare a suspension predicate, so JSON-authored agents settle idle deterministically instead of via `runAgent`'s timing heuristic (which logs a warning):

- **`suspendedTags` in the workflow config** (declarative, serializable): a list of state tags marking intentional waits for an external event. `fromConfig` lowers it into a `snapshot.hasTag(...)` predicate. Every listed tag must appear in some state's `tags` — an unused entry throws at build time. The published `schemas/agent-workflow.json` gains the optional `suspendedTags` property (backward compatible).

```jsonc
{
  "suspendedTags": ["awaiting-approval"],
  "states": {
    "awaitingApproval": {
      "tags": ["awaiting-approval"],
      "on": { "APPROVE": { "target": "resolved" } },
    },
  },
}
```

- **`isSuspended` on `FromConfigOptions`** (host-side function, for predicates JSON can't express): registered the same machine-carried way as `setupAgent({ isSuspended })`, surviving `machine.provide(...)`. Takes precedence over the config's `suspendedTags`; a `runAgent({ isSuspended })` host override beats both.
