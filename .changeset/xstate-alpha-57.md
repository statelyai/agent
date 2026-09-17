---
"@statelyai/agent": minor
---

**Require xstate `6.0.0-alpha.57`.**

The peer range moves to `>=6.0.0-alpha.57 <6.0.0`. Nothing in the library's own
API changes; the bump picks up alpha.57's structural setup state contracts
(`type` / `id` / `initial` / `history` / `target` / `route` in `setup({ states })`,
with strict transition targets) and the new `transitionMeta` schema.

alpha.57 also fixes declaration emit for machines built with `setup({ states })`
(statelyai/xstate#5722): the types those declarations reach for — `ActiveStateContext`,
`RootContextMarker`, the strict-target markers — are exported from the package
entry point now, so a package that exports such a machine can be built with
`declaration: true` again.
