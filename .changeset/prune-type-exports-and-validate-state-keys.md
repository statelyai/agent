---
"@statelyai/agent": minor
---

**Pruned dead root type exports and made a `setupAgent({ states })` typo a build error.**

- Removed root type exports no consumer could use: `AgentMachine`, `AgentMachineConfig`, `AgentRequestConfig` (a pure alias of `TextLogicConfig`), `DecisionLogic`, `AgentSetupStateSchema`, `AgentStateNarrowing`, `TextLogicInput`, `TextLogicOutput`, `AgentRequestMode`, `AgentModelMap`, `EventPayload`, `EventUnion`, `NormalizedEventSchemas`, `AgentEventSchemaInput`, `AgentEventSchemaInputMap`, `AllowedEventPattern`, `DataContent`, `ProviderOptions`, `ToolResultOutput`, `AgentToolSchema`. `AgentMachine`, `AgentMachineConfig`, `AgentRequestConfig`, `TextLogicInput` and `TextLogicOutput` are gone from the source too — the first two hardcoded `TActors = {}` and so could not describe a real machine.
- `setupAgent({ states })` now throws at `createMachine` time when a narrowing key does not name a state in the machine config, naming the bad key and listing the valid ones. A typo was previously a silent no-op. Keys are matched literally against each nesting level, so a narrowing key is a single state name, never a dotted path.
- Moved the `getAcceptedEvents` JSDoc onto the function it documents.

Separately, `setupAgent.fromConfig` rejects a dotted state key outright — see the `from-config-host-guards` changeset — and lint's reachability for config machines is fixed in `lint-reachability-from-config`.
