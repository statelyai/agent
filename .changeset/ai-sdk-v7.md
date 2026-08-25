---
"@statelyai/agent": minor
---

**AI SDK v7.** The `ai` peer dependency is now `^7`, paired with `@ai-sdk/openai@^4`.

`reasoning` on a text request is now the provider's reasoning-effort setting, passed through to the model untouched, the same way `temperature` is. It is not an agent concept, and core never reads it. The structured-output envelope opt-in that used to own that name is now `includeReasoning`, on `createTextLogic`, on `AgentTextRequest`, and in `agent-workflow.json`.

```ts
export const triageTicket = createTextLogic({
  schemas: { input: z.object({ ticket: z.string() }), output: triageSchema },
  model: "careful",
  reasoning: "high", // provider setting, forwarded as-is
  includeReasoning: true, // was `reasoning: true`
  prompt: ({ input }) => input.ticket,
});
```

Keeping the two apart restores the invariant that an `AgentTextRequest` is spread-compatible with the AI SDK's call options, so the raw `ai` `generateText`/`streamText` functions still work as executors with no adapter.

The rest of the migration is inside `createAiSdkExecutors`:

- v7 rejects `role: 'system'` inside `messages` unless the caller opts in. The adapter opts in, because an agent's messages are machine-authored server-side content, so `systemMessage()` keeps working.
- v7 moved `reasoningTokens` under `usage.outputTokenDetails` and the cached-input count under `usage.inputTokenDetails.cacheReadTokens`. The adapter folds both onto the flat fields `AgentUsage` aggregates, and passes the SDK's own shape (including `raw`) through untouched.
- `AgentToolDescriptor.description` now also accepts a function, matching a v7 tool whose description is computed per call.
