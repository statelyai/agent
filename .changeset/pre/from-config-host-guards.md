---
"@statelyai/agent": minor
---

**`setupAgent.fromConfig(...)` now accepts host implementations for guards and actions**, lowering configs onto XState v6's `createMachineFromConfig` JSON layer. A JSON-authored agent can finally branch on real logic.

```ts
const { machine } = setupAgent.fromConfig(config, {
  compileSchema,
  guards: { isFromHuman: ({ context }) => context.sender === "human" },
  actions: { notify: (params) => console.log(params.who) },
});
```

- **`guards`**: a guard string without `{{ }}` is a named guard reference resolved against `fromConfig(config, { guards })`, called with `{ context, event }`. Previously a bare-string guard was evaluated as a truthy literal, so the transition fired unconditionally. An unresolvable named guard is now a build-time error.
- **`actions`**: named action types (`{ type, params }`) resolve against `fromConfig(config, { actions })`, in transition actions as well as `entry`/`exit`, and receive the template-resolved `params`. Unresolvable names are a build-time error (previously transition-level named actions threw and entry/exit ones were silently unwired).
- `{{ }}` template expressions, choice states, emitted events, request lowering, `agent.decide` validation, and sibling-target linting are unchanged.

Breaking edges of the rewrite: a `choice` branch can no longer carry `actions` (use `assign` or the target state's `entry`; this throws at build time); a state key containing `.` now throws, since the dot is reserved as the state-path separator; and invoke-level `meta` is accepted by the type but dropped rather than carried onto the machine.
