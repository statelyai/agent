---
"@statelyai/agent": patch
---

**Fixed `lintAgentMachine` falsely reporting every state of a `setupAgent.fromConfig(...)` machine as dead.** `unreachable-state` and `missing-final` no longer fire on config-built machines.

XState's JSON layer folds a transition carrying a context patch (`assign`) into a single opaque `to` resolver, dropping its `target` from `machine.config` — so the static reachability walk saw no edges into those states and reported them, and every final state with them, as unreachable. The lowering now retains the config's declared transition targets (`on` / `always` / `after` / `onDone` / `choice`, plus each invoke's `onDone` / `onError`) alongside the machine, and lint reads reachability from those. Reachability is now exact for config machines rather than approximated: a genuinely orphaned state is still reported.

- `lintAgentMachine(machine)` works as-is on `fromConfig` machines — no API change — and the retained targets survive `machine.provide(...)`.
- Config-built machines no longer need `{ disable: ["unreachable-state", "missing-final"] }` as a workaround. The shipped `generate-machine` skill's guidance stands: do not disable checks.
- Hand-authored machines are unchanged: a dynamic (function) transition still over-approximates rather than false-flag, and a transition object carrying only a `to` resolver is now treated as opaque instead of as a targetless in-state transition.
