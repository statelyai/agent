---
"@statelyai/agent": minor
---

Removed the `@statelyai/agent/steps` and `@statelyai/agent/adapter` subpaths. Everything they exported is now on the root barrel — import from `@statelyai/agent`. Remaining entries: `.`, `./ai-sdk`, `./sqlite`, `./agent-workflow.json`.

Newly on the root barrel:

- From `/steps`: `executeAgentRequest`, `resolveDecision`, `renderDecisionAttempts`, `PLAN_DONE_EVENT_TYPE`, plus `AgentRequest`, `AgentPlanRequest`, `AgentStepRequest`, `DecisionLogicConfig`, `ResolveDecisionOptions`, `AgentRequestSource`.
- From `/adapter`: `bindRequestExecutor`, `buildEnvelopeSchema`, `getAgentOutputMode`, `parseStructuredEnvelope`, `parseModelRef`, `parseOutput`, `getJsonSchema`, `getJsonSchemaSync`, `isStandardSchema`, `getMachineStructuralHash`, plus `AgentOutputMode`, `StructuredOutputEnvelope`.

Not carried over (no longer public; the functions remain internal): `matchesEventPattern`, `validateSchemaSync`, `isStructuredOutputSchema`.
