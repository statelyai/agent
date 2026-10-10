---
"@statelyai/agent": minor
---

Lowered text requests now carry their registered name: `AgentTextRequest.name` is stamped from the `setupAgent({ requests })` key (also via `setupAgent.fromConfig`), or from the new `TextLogicConfig.name` for standalone `createTextLogic` actors. Host executors, per-request routers, and test mocks can route on `request.name` instead of sniffing `system`/`prompt` text.
