---
"@statelyai/agent": minor
---

Move `decideNext` and `createPolicyDecider`, with `DecideNextOptions`, `DecideNextResult`, and `PolicyDeciderOptions`, from the root export to a new `@statelyai/agent/policy` subpath. The root keeps `agent.decide` and the decision helpers a machine uses. Change the import path; the functions are unchanged.
