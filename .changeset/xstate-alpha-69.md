---
"@statelyai/agent": minor
---

**Require XState `6.0.0-alpha.69`** (was `6.0.0-alpha.64`) as both the peer and dev dependency.

**Breaking:** XState `alpha.69` changes what your code and your stored data see:

- Renamed exports: `serializeMachine` is now `machineToJSON`, `createMachineFromConfig` is now `machineFromJSON`, and `ExecutableActionObjectFromLogic` is now `ExecutableEffectFrom`.
- Persisted snapshots list `timers` as an array, and `version` moved to `machine.version`.
- XState's lifecycle events are `xstate.init` and `xstate.stop` (were `@xstate.init` and `@xstate.stop`). The agent runtime's own init event in `onTransition` and the event log is still `@xstate.init`.
- `"xstate.error.actor.*"` is no longer a valid `on` key. Use `"xstate.error.actor"`.
- A host timer scheduler (`timers: { schedule, cancel }`) still receives `{ id, delay }`, but `id` is now an opaque JSON string. Pass it back unchanged as `{ type: "xstate.timer", id }`.
