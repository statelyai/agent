---
"@statelyai/agent": minor
---

Run-to-completion helper, snapshot version stamping, and observation/store ergonomics:

- **`runAgentToCompletion(machine, options)`**: wraps `runAgent` for run-to-done flows and returns the machine's output directly. A `done` result resolves with `result.output`; an `idle` result throws `AgentIdleError` (carrying the idle `snapshot` and the `acceptedTypes` that could resume it); an `error` result rethrows the underlying `Error`, or wraps a non-`Error` in an `Error` whose `.cause` is the `RunAgentErrorCause` and `.error` the raw value. Use `runAgent` directly when idle is expected.
- **Snapshot version stamping.** Every settled result's `snapshot` (and `persistedSnapshot` when present) now carries a plain, JSON-safe `agentMeta: { machineId, version }` field. `version` defaults to `getMachineStructuralHash(machine)` (a new exported, dependency-free hash over the machine's structure (state ids/nesting, transition event types + targets, invoke srcs, `initial`), ignoring functions/prompts) or an explicit `options.machineVersion`. On resume, a mismatched incoming stamp is handled per `options.onVersionMismatch` (`'throw'` default → `SnapshotVersionMismatchError` with `from`/`to`, `'warn'`, `'ignore'`) or via `options.migrateSnapshot(snapshot, { from, to })` (its return value is resumed from). Unstamped snapshots are always accepted.
- **`inspectTransitions(handler)`**: wraps `runAgent`'s `inspect` option: filters the system-wide inspection stream to `@xstate.transition` events and hands the handler the typed snapshot + actorRef (with `id`/`src`), for attributing invoked child machines. New `InspectedActorRef` type.
- **`AgentSnapshotStore`** type-only export: the shared `load(id)`/`save(id, snapshot)` contract so userland snapshot stores interoperate. Zero runtime.
