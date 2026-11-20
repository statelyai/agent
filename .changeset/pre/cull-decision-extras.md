---
"@statelyai/agent": major
---

Removed five APIs that encoded domain patterns. The library keeps the generic primitives they were built from.

- Removed the `@statelyai/agent/policy` subpath and `createPolicyDecider` with `PolicyDeciderOptions`. `decideNext`, `DecideNextOptions`, and `DecideNextResult` are exported from `@statelyai/agent` again. To run a policy machine as a decider, pass a plain `decide` executor that calls `runAgent(policyMachine, { input })` and returns its output event.
- Removed decision strategies: the `strategy`, `fillModel`, and `groups` options on `agent.decide`, `createDecisionLogic`, `createDecisionRequest`, and `decideNext`, with `DecisionStrategy` and `MAX_FINITE_PAYLOADS`. A decision is one `decide` call over every candidate event. Sub-call keys ending in `.pick`, `.group`, or `.fill` are no longer issued. `verifyAgentConfig` no longer reports a missing `fillModel`, and the `missing-fill-model` error is gone. A decision model such as Jev answers closed choices, so give the decision `payloads`.
- Removed `createGeneratorBridge`, `GeneratorBridge`, and `ForwardResult`. Write the generator pull loop by hand.
- Removed `getDecisionRequests`, `GetDecisionRequestsOptions`, and `TracedDecisionRequest` from `@statelyai/agent/evals`. Read the `request.start` trace events directly.
- Removed `summarizeRepeats` from `@statelyai/agent/evals`. Use `repeatRuns`, which returns the same report.
