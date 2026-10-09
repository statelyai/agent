---
"@statelyai/agent": minor
---

**TanStack AI adapter.** `@statelyai/agent/tanstack-ai` adds `createTanStackAiExecutors`, the `{ generateText, streamText, decide }` executor set over TanStack AI's `chat()`, alongside the AI SDK and OpenAI adapters. Any TanStack AI text adapter is a model:

```ts
import { openaiText } from "@tanstack/ai-openai";
import { createTanStackAiExecutors } from "@statelyai/agent/tanstack-ai";

const executors = createTanStackAiExecutors({
  models: { quick: openaiText("gpt-5.4-mini") },
});
```

- `models`, `resolveModel`, and `settings` work as in `createAiSdkExecutors`; a model entry can be `{ adapter, settings }`.
- Structured output, tool loops bounded by `maxSteps` (in `generateText` and `streamText`), forced-tool decisions, usage summed over model turns, and `AgentTruncatedError` all follow the shared adapter contract.
- A request's generation settings and `toolChoice` map onto `modelOptions` for the `openai`, `anthropic`, and `gemini` providers. For others, map them in a `settings` function.

`@tanstack/ai` (`>=0.66.0 <1`) is a new optional peer dependency.
