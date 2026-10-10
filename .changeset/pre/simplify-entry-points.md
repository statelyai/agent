---
"@statelyai/agent": minor
---

Simplify the public API surface.

- **New entry points.** Testing and eval tooling moved to `@statelyai/agent/testing` (`lintAgentMachine`, `assertAgentMachine`, `simulateAgent`, `explorePaths`, `canReach`, `createScriptedExecutors`, `matchesTrajectory`, `runSeam`). Event-log primitives moved to `@statelyai/agent/log` (`replay`, `forkEventLog`, `initEntry`, `createReplayEntry`, `getUsageFromEvents`, `createInMemoryEventLogStore`, `assertEventLogStoreConformance`, and friends). The root keeps `AgentLogEntry`, `AgentEventLogStore`, and the errors `runAgent` throws.
- **Step API exported.** `initialAgentStep`, `transitionAgentStep`, `resolveAgentStep`, `rejectAgentStep`, and the `AgentStep` type are now public from the root, alongside `executeAgentRequest`. This is the pure `(state, event) => (state, requests)` view of a machine that `simulateAgent` already ran on; any host can drive it.
- **Removed `runAgentLoop`.** Write the loop: `while (result.status === "idle") result = await runAgent(machine, { snapshot: result.persist(), event, executors })`.
- `executeAgentRequest` now takes an `AgentStepRequest` only; the undocumented effect-shaped argument is gone.
- `EventLogStoreConformanceHarness` no longer accepts an unused `expect` field.
