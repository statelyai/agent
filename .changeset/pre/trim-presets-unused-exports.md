---
"@statelyai/agent": minor
---

Remove seven preset factories from `@statelyai/agent/machines`: `createToolLoopMachine`, `createSequentialMachine`, `createRouterMachine`, `createParallelMachine`, `createLoopMachine`, `createSupervisorMachine`, and `createHandoffMachine`, with `routeEventType`, `delegateEventType`, `transferEventType`, `FINISH_EVENT_TYPE`, and the `PresetEntry` types. `createApprovalBatchMachine` stays. For the other shapes, copy the matching example (`prompt-chaining`, `agent-supervisor`, `swarm-handoff`, `parallel-streams`, `map-reduce`).

Remove `inspectTransitions` and its `InspectedActorRef` type; filter `@xstate.transition` events in your own `inspect` handler, or use `traceTransitions`. `getMachineStructuralHash` and `rebindActorSession` (from `@statelyai/agent/log`) are no longer exported; set `version` on the machine to pin snapshot identity.
