---
"@statelyai/agent": minor
---

**Payload and output branching in `explorePaths` and `canReach`.** Exploration no longer applies every event as a bare `{ type }`, so guards that read the payload are explored too.

- `payloads(snapshot)`: payloads per event type at each branch point. A type with an entry forks once per payload, at decisions and idle waits; guard-rejected variants count in `prunedByGuard`. A decide input's own `payloads` become that decision's branch set.
- A type with no entry is filled from its event schema: each finite field (`enum`, `const`, `boolean`, `null`, or a union of those) contributes its values, and an optional one also the omitted case, up to 64 combinations. Plain XState machines are filled from their own `schemas.events`. A type the fill cannot enumerate (a non-finite field, or over 64) is listed in the new `report.unexpandedEvents`, so you know which `payloads` entries to add.
- `outputs`: every output to try per src. Two or more fork one branch each, so `onDone` branching on the output is explored down every arm.
- `dedupeBy(snapshot)`: a key for settled snapshots, each explored once, so converging branches stay tractable.
- `maxNodes` (default 100,000) caps the branch points expanded, bounding work and memory on loopy machines where `maxPaths` alone cannot. `hitPathCap` is true when either cap cut exploration short.
- `canReach` results carry `complete`. It is false when a cap or `maxDepth` cut the search short, a branch stopped `needs-output`, or an event type was not fully expanded, so `reachable: false` is a proof only when `complete` is true.

```ts
const violation = await canReach(refundMachine, "illegallyIssued", {
  payloads: () => ({ ISSUE: [0, 100, 100.01, 500].map((amount) => ({ amount })) }),
  outputs: { lookupOrder: [{ found: true }, { found: false }] },
  dedupeBy: (snapshot) => JSON.stringify([snapshot.value, snapshot.context]),
});
```
