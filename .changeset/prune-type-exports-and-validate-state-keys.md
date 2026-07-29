---
"@statelyai/agent": minor
---

Root type-export prune and a `setupAgent({ states })` typo guard:

- Removed dead root type exports that no consumer could use: `AgentMachine`, `AgentMachineConfig`, `AgentRequestConfig` (a pure alias of `TextLogicConfig`), `AgentRequestSource`, `DecisionLogic`, `AgentSetupStateSchema`, `AgentStateNarrowing`, `TextLogicInput`, `TextLogicOutput`, `AgentRequestMode`, `AgentModelMap`, `EventPayload`, `EventUnion`, `NormalizedEventSchemas`, `AgentEventSchemaInput`, `AgentEventSchemaInputMap`, `AllowedEventPattern`, `DataContent`, `ProviderOptions`, `ToolResultOutput`, `AgentToolSchema`. `AgentMachine`/`AgentMachineConfig`/`AgentRequestConfig` are gone from the source too — the first two hardcoded `TActors = {}` and so could not describe a real machine.
- `setupAgent({ states })` now throws at `createMachine` time when a narrowing key does not name a state in the machine config, naming the bad key and listing the valid ones. A typo was previously a silent no-op.
- Moved the `getAcceptedEvents` JSDoc onto the function it documents.
