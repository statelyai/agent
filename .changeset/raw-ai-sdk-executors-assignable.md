---
"@statelyai/agent": patch
---

The raw Vercel AI SDK `generateText`/`streamText` functions now typecheck when passed directly as executors (`executors: { generateText, streamText }`) — no casts needed. `AgentRequestExecutor` now receives an `AgentExecutorTextRequest` (exported): the same runtime object as before, typed so it is assignable to `ai`'s call options (`prompt`/`messages` mutually exclusive; `tools`/`toolChoice`/`messages` widened). Hand-written executors annotating `AgentTextRequest & { tools: AgentTools }` remain assignable unchanged. `AiSdkShapedTextResult`/`AiSdkShapedStreamResult` swap their index signatures for explicit optional passthrough fields so `ai`'s result interfaces are admitted.
