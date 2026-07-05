---
"@statelyai/agent": patch
---

Improve type-level DX so authoring no longer forces user-side casts:

- `createDecisionLogic`'s `allowedEvents` resolver now receives its `input` typed
  from the `schemas.input` schema (was `unknown`).
- `resolveDecision` is now generic over the machine's event union: typing
  `canTake` (e.g. `(e: GameEvent) => snapshot.can(e)`) makes it return that union,
  removing the re-narrowing parser hosts previously hand-wrote.
- `AllowedEvents` gained a `TInput` parameter to carry the resolver input type.

Also cleaned up stale casts/annotations in examples that these (and existing
inference) made unnecessary: child-machine `onDone` output and `invoke.input`
`context` were already correctly inferred.
