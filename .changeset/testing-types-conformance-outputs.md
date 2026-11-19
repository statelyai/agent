---
"@statelyai/agent": minor
---

`@statelyai/agent/testing` loads under the Cloudflare Vitest pool. The built `.mjs` and `.cjs` files no longer carry JSDoc comments, so a `vi.mock(` example in one no longer makes Vitest 4 hoist the module and drop its re-exports. The `.d.mts` and `.d.cts` files keep the JSDoc.

`checkConformance` validates what the mapping feeds the model. An actor output that the actor's declared output schema rejects is an `invalid-output` deviation, and an event payload that the model's event schema rejects is an `invalid-event` deviation. Both carry the schema's message in `schemaError`. A malformed model-call output no longer throws a `TypeError` from the model's `onDone`.

`checkConformance` callbacks are typed from the model and the observations. `actors` keys are the model's actor srcs, `observes` is one of the observation kinds, `observation` is narrowed to that kind, `input` has the actor's input type, and an event's `matches` reads the model's typed `context`. A misspelled src or kind is a compile error. An options object built outside the call needs `as const` on its `observes` values.

`canReach` and `explorePaths` type the snapshot their predicate, `payloads`, and `dedupeBy` receive as the machine's own snapshot, so `snapshot.context` needs no cast.

The default `maxPaths` for `canReach` and `explorePaths` is 10,000, up from 200.
