---
"@statelyai/agent": minor
---

`setupAgent.fromConfig(...)` now lowers configs onto XState v6's `createMachineFromConfig` JSON layer and accepts host implementations:

- New `guards` option: a guard string without `{{ }}` is a named guard reference resolved against `fromConfig(config, { guards })`. Implementations are called with `{ context, event }`. Previously a bare-string guard was evaluated as a truthy literal, so the transition fired unconditionally; an unresolvable named guard is now a build-time error instead.
- New `actions` option: named action types (`{ type, params }`) resolve against `fromConfig(config, { actions })`, in transition actions as well as `entry`/`exit`. Implementations receive the template-resolved `params`. Unresolvable named action types are a build-time error (previously transition-level named actions threw and entry/exit ones were unwired).
- `{{ }}` template expressions, choice states, emitted events, request lowering, `agent.decide` validation, and sibling-target linting are unchanged.

Breaking edges of the rewrite: a `choice` branch can no longer carry `actions` (use `assign` or the target state's `entry`; this now throws at build time), guardless `choice` branches must be last, and invoke-level `meta` is no longer carried onto the machine.
