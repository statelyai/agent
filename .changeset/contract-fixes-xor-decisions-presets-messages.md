---
"@statelyai/agent": minor
---

**Four API contract fixes.**

- Agent text requests now reject a request that supplies both a non-empty `prompt` and a non-empty `messages` array — the same rule the executor types already declared. Provide exactly one input source.
- `createDecisionLogic` is now exported from the package root (along with its `DecisionLogic` return type), matching the already-exported `DecisionLogicConfig`.
- The machine preset factories (`createToolLoopMachine`, `createSequentialMachine`, `createParallelMachine`, `createLoopMachine`, `createRouterMachine`, `createSupervisorMachine`, `createHandoffMachine`) return typed machines instead of `AnyStateMachine`. Router, supervisor, and handoff are generic over their route/worker/agent maps, so inputs, outputs, and per-name events (`ROUTE_<name>`, `DELEGATE_<name>`, `transfer_to_<name>`) are all inferred — malformed input like `{ prompt: 123 }` is now a compile error.
- `messagesSchema` validates message part payloads, not just part `type` tags: text parts need a string `text`, tool calls need `toolCallId`/`toolName`/`input`, tool results need a well-formed `output` envelope, and so on. Extra fields are still allowed.
