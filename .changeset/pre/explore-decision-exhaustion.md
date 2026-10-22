---
"@statelyai/agent": patch
---

`explorePaths` and `canReach` follow a decision that cannot succeed the way a live run does.

- A decision with no candidate the snapshot takes (its guards refuse every one, or a closed choice has nothing on offer) exhausts: the branch records `{ type: 'xstate.error.actor.<id>' }` and takes the invoke's `onError`, or ends in an `error` terminal without one. It used to end without a branch, so `canReach` could report a state behind that `onError` as unreachable while a live run reached it.
- With an `errors` entry for a decision src, the failure and the candidate events are sibling branches, each one level of `maxDepth` deep. The candidates used to spend two levels, so a path within `maxDepth` could stop as `max-depth`.
- A wait where the guards refuse every offered event records an `idle` terminal and lists those types in `unexpandedEvents`, so `canReach` reports `complete: false`. The path used to end with nothing recorded, which could make an empty payload table look like a proof.
- An explorer `payloads` entry of `[]` for a type a wait accepts lists that type in `unexpandedEvents`, because its branches were skipped.
