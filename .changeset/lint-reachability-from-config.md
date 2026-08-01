---
"@statelyai/agent": patch
---

Fixed `lintAgentMachine`'s `unreachable-state` and `missing-final` checks false-flagging `setupAgent.fromConfig(...)` machines.

XState's JSON layer folds a transition that carries a context patch (`assign`) into a single opaque `to` resolver, dropping its `target` from `machine.config` — so the static reachability walk saw no edges into those states and reported every one of them (and, with them, every final state) as dead. The lowering now retains the config's declared transition targets (`on`/`always`/`after`/`onDone`/`choice` plus each invoke's `onDone`/`onError`) alongside the machine, and lint reads reachability from those. Reachability is now exact for config machines rather than approximated: a genuinely orphaned state is still reported.

- `lintAgentMachine(machine)` works as-is on `fromConfig` machines — no API change, and the retained targets survive `machine.provide(...)`.
- `{ disable: ["unreachable-state", "missing-final"] }` is no longer needed for config-built machines (removed from `examples/generated-machine`).
- Hand-authored machines are unchanged: a dynamic (function) transition still over-approximates rather than false-flag. A transition object carrying only a `to` resolver is now treated as opaque instead of as a targetless in-state transition.
