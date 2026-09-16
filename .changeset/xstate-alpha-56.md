---
"@statelyai/agent": minor
---

**Require xstate `6.0.0-alpha.56`.**

The peer range moves to `>=6.0.0-alpha.56 <6.0.0`. Nothing in the library's own
API changes; the bump picks up alpha.56's structural setup state contracts
(`type` / `id` / `initial` / `history` / `target` / `route` in `setup({ states })`,
with strict transition targets) and the new `transitionMeta` schema.

Known issue in alpha.56: a machine that declares narrowed per-state `context`
cannot have its type named in a `.d.ts` (TS2742), because `RootContextMarker`
and `ActiveStateContext` are declared in xstate's `setup` module but not
re-exported from the package entry point, leaving TypeScript no public path to
name them. That only affects declaration emit for code that exports such a
machine — running, testing and `noEmit` typechecking are unaffected.
