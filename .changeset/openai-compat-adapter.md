---
"@statelyai/agent": minor
---

Add `@statelyai/agent/openai-compat`, a second shipped adapter. `createOpenAiCompatExecutors({ baseUrl, apiKey?, headers?, fetch?, model?, models? })` returns a complete `{ generateText, streamText, decide }` executor set over the OpenAI Chat Completions wire format via raw `fetch`, with zero runtime dependencies. Works with any compatible endpoint — Groq, Together, Ollama, vLLM, OpenRouter, LM Studio, and OpenAI itself. Unlike the raw AI SDK path, this includes `decide` (tool-per-event + `tool_choice: "required"`) and reliable structured output (`response_format` json_schema). Pass a `fetch` override for Workers or tests.
