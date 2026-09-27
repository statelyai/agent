---
"@statelyai/agent": minor
---

**Breaking: `createScriptedExecutors` is removed.** The library no longer ships a model mock. `createScriptedExecutors` and the `ScriptedByName`, `ScriptedDecisionEntry`, `ScriptedDecisionValue`, `ScriptedExecutors`, `ScriptedExecutorsScript`, and `ScriptedTextEntry` types are gone from both `@statelyai/agent` and `@statelyai/agent/testing`.

To test a machine without a live model, mock at the provider or pass a plain function:

- Mock the model with the AI SDK's own `MockLanguageModelV3` (from `ai/test`) and run it through `createAiSdkExecutors`, so the test covers the real adapter path.
- Or pass a plain executor: `executors: { generateText: async (request) => ({ result: "…" }), decide: async () => ({ event: { type: "WRITE" } }) }`.

`runSeam` is unchanged. Its `scripts` entries are now typed `SeamScriptEntry` (exported from `@statelyai/agent/testing`), with the same conventions: a value, an `{ result, usage? }` executor result, or a function of the request.
