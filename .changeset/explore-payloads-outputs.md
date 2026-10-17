---
"@statelyai/agent": minor
---

**Payload and output branching in `explorePaths` and `canReach`.** Exploration no longer applies every event as a bare `{ type }`, so guards that read the payload are explored too.

- `payloads(snapshot)`: payloads per event type at each branch point. A type with an entry forks once per payload, at decisions and idle waits; guard-rejected variants count in `prunedByGuard`. A decide input's own `payloads` become that decision's branch set.
- A type with no entry is filled from its event schema when every required field is a finite domain (`enum`, `const`, `boolean`, or a union of those), up to 64 combinations. Plain XState machines are filled from their own `schemas.events`.
- `outputs`: every output to try per src. Two or more fork one branch each, so `onDone` branching on the output is explored down every arm.
- `dedupeBy(snapshot)`: a key for settled snapshots, each explored once, so converging branches stay tractable.
- `canReach` results carry `complete`. It is false when the path cap or `maxDepth` cut the search short, so `reachable: false` is a proof only when `complete` is true.

```ts
const violation = await canReach(refundMachine, "illegallyIssued", {
  payloads: () => ({ ISSUE: [0, 100, 100.01, 500].map((amount) => ({ amount })) }),
  outputs: { lookupOrder: [{ found: true }, { found: false }] },
  dedupeBy: (snapshot) => JSON.stringify([snapshot.value, snapshot.context]),
});
```
