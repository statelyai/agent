---
'@statelyai/agent': major
---

- `agent.generateText(…)` is removed in favor of using the AI SDK's `generateText(…)` function with a wrapped model.
- `agent.streamText(…)` is removed in favor of using the AI SDK's `streamText(…)` function with a wrapped model.
- Custom adapters are removed for now, but may be re-added in future releases. Using the AI SDK is recommended for now.
- Correlation IDs are removed in favor of using [OpenTelemetry with the AI SDK](https://sdk.vercel.ai/docs/ai-sdk-core/telemetry#telemetry).
- The `createAgentMiddleware(…)` function was introduced to facilitate agent message history. You can also use `agent.wrap(model)` to wrap a model with Stately Agent middleware.
