---
"@statelyai/agent": patch
---

**Fix: `agent.decide` honors the invoke input's `maxRetries`.** `createAgentRuntime` and `simulateAgent` used the builtin decision logic's fixed budget of 2 retries and ignored `maxRetries` set in an `agent.decide` invoke's input. The lowered request now carries the input's `maxRetries` and both hosts prefer it, falling back to the logic's configured value (so `createDecisionLogic({ maxRetries })` behaves as before).
