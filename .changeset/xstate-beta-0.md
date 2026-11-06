---
"@statelyai/agent": patch
---

Require `xstate@6.0.0-beta.0`. Snapshots and event logs are restored through `restoreActor` from `xstate/persist` (`machine.restoreSnapshot` and the `snapshot` actor option are gone in the beta). Snapshots persisted under a v6 alpha, including init entries that carry one, do not restore unchanged: the beta renamed timer `startedAt` to `scheduledAt` and changed the actor-ref marker. Drain or discard them before upgrading.
