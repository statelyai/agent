---
"@statelyai/agent": minor
---

The executor adapters no longer export their internal mappers. `@statelyai/agent/ai-sdk` drops `toLanguageModel`; `@statelyai/agent/openai` drops `addAgentCallUsage`, `toAgentCallUsage`, `toAgentFinishReason`, `toDecisionMessages`, `toOpenAiCallSettings`, `toOpenAiEventTools`, `toOpenAiMessages`, `toOpenAiToolChoice`, and `toOpenAiTools`; `@statelyai/agent/tanstack-ai` drops `toAgentCallUsage`, `toAgentFinishReason`, `toDecisionMessages`, `toTanStackAiEventTools`, `toTanStackAiMessages`, `toTanStackAiModelOptions`, `toTanStackAiTools`, and `toTextAdapter`. Each subpath's `create*Executors` function and its option and result types are unchanged. The AI SDK adapter now normalizes `maxSteps` the way the OpenAI and TanStack AI adapters already did: a fractional value is floored, and a value below one or not finite becomes `1`, instead of reaching `stepCountIs` and never stopping the tool loop.
