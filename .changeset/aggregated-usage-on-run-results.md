---
"@statelyai/agent": minor
---

Aggregated model-call usage on run results.

- New `AgentUsage` type (and its per-call companion `AgentCallUsage`): `inputTokens`, `outputTokens`, `totalTokens`, `reasoningTokens`, `cachedInputTokens`, plus an always-present `modelCalls` count.
- Every `RunAgentResult` variant (`done`, `idle`, `error`) now carries `usage`, so `generateResult(...)` resolves `{ output, snapshot, events, usage }` — the shape `generateText` users expect.
- Executors report per-call usage on their result: `{ output, usage }` for text executors, `{ event, usage }` for `decide`. The AI SDK adapter's `LanguageModelUsage` already fits, so `createAiSdkExecutors` needs no extra wiring.
- Token fields are partial sums: each one sums only the calls that reported it and stays `undefined` when no call did. `modelCalls` counts every call the run made (decision retries count separately). Aggregation is per-run — a resumed run counts its own calls only.
- `request.end` trace events carry the optional per-call `usage`, on both the `runAgent` and `provideExecutors` paths; `serializeTraceEvent` passes it through.
