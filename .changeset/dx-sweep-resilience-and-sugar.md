---
"@statelyai/agent": minor
---

DX sweep: structured-output resilience, per-state narrowing sugar, string userInput, host helpers.

- **Structured-output resilience (AI SDK adapter).** `createAiSdkExecutors.generateText` now repairs a malformed structured response by extracting the first complete JSON value (models occasionally emit two concatenated `{ result }` envelopes), and retries the request once on `NoObjectGeneratedError`. Retry applies only to tool-free requests: a request carrying tools may already have executed side effects, so it fails fast instead. New export: `extractFirstJsonValue`.
- **Per-state context narrowing sugar.** `setupAgent({ states })` entries accept `{ context: { field: schema } }`: declare only the fields that change; every other field keeps the base context schema. Resolves to xstate's full `{ schemas: { context } }` form (still supported). Empty `{}` state entries are no longer needed. New types: `AgentSetupStateSchema`, `AgentStateNarrowing`.
- **`agent.userInput` resolves to `string`.** The builtin's output and `AgentUserInputExecutor` are now typed `string` (what the human typed) instead of `unknown`, so `onDone: ({ output }) => …` needs no coercion. The unused `schema` field was removed from `AgentUserInput`; for structured input, classify the string in a follow-up state or register a custom actor source.
- **Host helpers.** `parseModelRef(ref)` splits a portable `"provider/model-id"` ref; `parseStructuredEnvelope(request, value)` is the checked unwrap of the structured-output envelope (replaces `as StructuredOutputEnvelope` casts in hand-rolled hosts); `bindRequestExecutor` accepts `{ onChunk }` for streaming logics.
