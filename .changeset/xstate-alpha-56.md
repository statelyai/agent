---
"@statelyai/agent": minor
---

**Require xstate `6.0.0-alpha.56`.**

The peer range moves to `>=6.0.0-alpha.56 <6.0.0`. Nothing in the library's own
API changes; the bump picks up alpha.56's structural setup state contracts
(`type` / `id` / `initial` / `history` / `target` / `route` in `setup({ states })`,
with strict transition targets) and the new `transitionMeta` schema.

Known issue in alpha.56: a machine that declares narrowed per-state `context`
cannot have its type named in a `.d.ts` (TS2742), because the types declaration
emit needs — `ActiveStateContext` and the strict-target markers — are not
exported from xstate's package entry point. Fixed upstream in
statelyai/xstate#5722; until that ships, this affects declaration emit only.
Running, testing and `noEmit` typechecking are unaffected.
