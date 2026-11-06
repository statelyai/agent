---
"@statelyai/agent": patch
---

Export every type that can appear in the inferred type of a `setupAgent(...).createMachine(...)` machine, `createAgentRuntime` value, `runAgent` result, or preset machine (`WithAgentInputSchema`, `EventUnion`, `AgentEventSchemaInputMap`, `BuiltinAgentActors`, `DecisionModeOption`, and others), so consumers compiled with `declaration: true` or `composite: true` no longer hit TS2742 "cannot be named without a reference to .../dist/types-<hash>.mjs".
