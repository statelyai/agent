---
"@statelyai/agent": minor
---

**Four API contract fixes.**

- Agent text requests now require exactly one non-empty `prompt` or non-empty `messages` array at every execution boundary, matching the executor types.
- `createDecisionLogic` is now exported from the package root (along with its `DecisionLogic` return type), matching the already-exported `DecisionLogicConfig`.
- The machine preset factories (`createToolLoopMachine`, `createSequentialMachine`, `createParallelMachine`, `createLoopMachine`, `createRouterMachine`, `createSupervisorMachine`, `createHandoffMachine`) return typed machines instead of `AnyStateMachine`. Router, supervisor, and handoff are generic over their route/worker/agent maps, so inputs, outputs, and per-name events (`ROUTE_<name>`, `DELEGATE_<name>`, `transfer_to_<name>`) are all inferred — malformed input like `{ prompt: 123 }` is now a compile error.
- `messagesSchema` validates role-appropriate parts, supported media payloads, nested tool-result content, and required output values in addition to each part's fields. Extra fields are still allowed.
