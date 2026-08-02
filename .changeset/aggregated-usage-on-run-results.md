---
"@statelyai/agent": minor
---

**Every run result now reports what it spent.** `usage` is on all three `RunAgentResult` variants (`done`, `idle`, `error`), so a run's cost needs no side-channel.

```ts
const result = await runAgent(machine, { input, executors });
console.log(`${result.usage.modelCalls} calls, ${result.usage.totalTokens ?? 0} tokens`);
```

- New `AgentUsage` type (and per-call `AgentCallUsage`): `inputTokens`, `outputTokens`, `totalTokens`, `reasoningTokens`, `cachedInputTokens`, plus an always-present `modelCalls`.
- `generateResult(...)` resolves `{ output, snapshot, events, usage }` — the shape `generateText` users expect.
- Executors report per-call usage on their result: `{ output, usage }` for text, `{ event, usage }` for `decide`. The AI SDK's `LanguageModelUsage` already fits, so `createAiSdkExecutors` needs no wiring.
- Token fields are partial sums: each sums only the calls that reported it and stays `undefined` when none did. Only `modelCalls` is always present, and it counts every call (decision retries separately). Aggregation is per-run — a resumed run counts its own calls only.
- `request.end` trace events carry the optional per-call `usage` on both the `runAgent` and `provideExecutors` paths; `serializeTraceEvent` passes it through.
