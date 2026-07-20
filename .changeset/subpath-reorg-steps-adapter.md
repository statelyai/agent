---
"@statelyai/agent": minor
---

Public API reorganization: a leaner root barrel, with adapter-author and durable-host plumbing moved behind two new subpaths. Breaking (alpha).

**New subpaths**

- `@statelyai/agent/steps` — the durable, per-model-call step path and decision control-flow: `initialAgentStep`, `transitionAgentStep`, `resolveAgentStep`, `getAgentRequests`, `executeAgentRequest`, `resolveAgentRequests`, `resolveDecision`, `renderDecisionAttempts`, `PLAN_DONE_EVENT_TYPE` (plus `AgentStep`/`AgentRequest`/`AgentPlanRequest`/`AgentStepRequest`, `ResolveAgentRequestsOptions`, `ResolveDecisionOptions`, `DecisionLogicConfig`).
- `@statelyai/agent/adapter` — the adapter-author seam: `bindRequestExecutor`, `buildEnvelopeSchema`, `parseStructuredEnvelope`, `getAgentOutputMode`, `isStructuredOutputSchema`, `parseOutput`, `parseModelRef`, `getJsonSchema`, `getJsonSchemaSync`, `isStandardSchema`, `validateSchemaSync`, `getMachineStructuralHash`, `matchesEventPattern` (plus `StructuredOutputEnvelope`, `AgentOutputMode`).

All of the above moved OFF the root barrel — update imports to the new subpaths.

**Removed outright**

- `EVENT_TOOL_PREFIX` (now internal; it just prefixes generated event tool names as `send_event_`).
- `extractJsonSchema` from `@statelyai/agent/openai-compat` — use `getJsonSchema` from `@statelyai/agent/adapter` (identical function).

**Other changes**

- New root type export `PlanLogic` — fixes TS4023 "cannot be named" when re-exporting a machine that uses `agent.plan`.
- `AgentRequestExecutors` slots are now all optional (`generateText?`, `streamText?`, `decide?`); a missing slot is still a clear bind-time error when the machine needs it. Adapter result sets (`AiSdkExecutors`, `OpenAiCompatExecutors`) still require all three.
- `SimulationScript.userInput` renamed to `invokes` (the by-src scripted-invoke channel for `simulateAgent`; unrelated to the `agent.userInput` actor).
