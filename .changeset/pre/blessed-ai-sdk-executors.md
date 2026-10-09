---
"@statelyai/agent": minor
---

`runAgent`'s `generateText`/`streamText` executors now accept the raw Vercel AI SDK functions directly (`runAgent(machine, { generateText, streamText })` with the functions imported from `ai`). Their result shapes are unwrapped natively: `generateText`'s `{ text }` and `streamText`'s `{ textStream }` (chunks forwarded to `onChunk`, final text from `await result.text`). Structured-output requests through raw functions are best-effort (JSON-parsed against the `outputSchema`); use `createAiSdkExecutors` from `@statelyai/agent/ai-sdk` for reliable structured output. `decide` still requires an adapter.
