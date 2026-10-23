---
"@statelyai/agent": minor
---

**`createPolicyDecider` runs a policy machine as a decide executor.** Each decision request starts one policy run, whose output event is the choice. The input defaults to the request's `metadata.facts`, offered events, `system`, and `prompt`; the policy's token usage is reported on the result. A run that does not end `done` with an event throws `AgentError` with code `policy-not-done`. With a `store`, each decision's policy run gets its own thread (`policy:<callKey>:<input hash>` by default, or `threadId: (request, info) => ...`). The input must be JSON: the default drops `undefined` keys, and anything else that is not JSON throws before the run.

**`getDecisionRequests` reads the decisions a run asked for from its trace.** From `@statelyai/agent/testing`: `getDecisionRequests(trace, { name? })` returns each decision's first-attempt request with the states it was asked in, from a live or serialized trace, for eval rows and policy probes.
