---
"@statelyai/agent": minor
---

`AgentRequestExecutor`'s return type is widened to also admit the raw Vercel AI SDK result shapes: `AiSdkShapedTextResult` (`{ text }`) and `AiSdkShapedStreamResult` (`{ textStream }`), alongside the existing `{ output }` `AgentRequestExecutorResult` envelope. Raw `ai` `generateText`/`streamText` functions now pass to `runAgent`'s `generateText`/`streamText` executors without a cast (`normalizeGeneratorResult` already unwrapped these shapes at runtime; this aligns the types). Type-only change, no runtime behavior change. The two new type names are exported from the package root.
