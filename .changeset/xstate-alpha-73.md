---
"@statelyai/agent": patch
---

Require `xstate@6.0.0-alpha.73`. Machines without an `id` are journaled with XState's empty-string id instead of `"(machine)"`. Inline (direct-object) invokes are keyed by their invoke `id`. An actor resolving `null` now reaches `onDone` with `output: null`.
