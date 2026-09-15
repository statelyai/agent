---
"@statelyai/agent": minor
---

**Require xstate `6.0.0-alpha.54`.**

The peer range moves to `>=6.0.0-alpha.54 <6.0.0`. Nothing in the library's own
API changes; the bump picks up alpha.54's structural setup state contracts
(`type` / `id` / `initial` / `history` / `target` / `route` in `setup({ states })`,
with strict transition targets) and the new `transitionMeta` schema.

Known issue in alpha.54: a machine that declares narrowed per-state `context`
and handles a transition with a function inside one of those states cannot have
its type named in a `.d.ts` (TS4023, on xstate's internal `rootContext` unique
symbol). That only affects declaration emit for code that exports such a
machine — running, testing and `noEmit` typechecking are unaffected.
