---
"@statelyai/agent": minor
---

`decideNext` takes `metadata`, passed through as `request.metadata`, and `callKey`, the decision's idempotency key (each attempt's executor `info.callKey` is `${callKey}.${attempt}`, as under `agent.decide`). `createPolicyDecider(policy)` now answers `decideNext` with its defaults: the policy reads `facts` from `metadata.facts`, and with a `store` names each policy thread from the call key. A wildcard handler (`on: { "desk.*": ... }`) now offers the registered event types it matches, by xstate's matching rule, in `getAcceptedEvents`, `decideNext`, and `agent.decide`. An `agent.decide` with no candidate event still fails with `AgentDecisionExhaustedError` before any model call, now with a message that says why.
