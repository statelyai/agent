---
"@statelyai/agent": patch
---

The AI SDK adapter passes provider-defined tools such as `openai.tools.webSearch()` through unchanged. Before, it rebuilt them as plain tools without their `id`, so the provider never ran them.
