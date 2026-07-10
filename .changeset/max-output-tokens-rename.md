---
"@statelyai/agent": minor
---

Breaking: `maxTokens` renamed to `maxOutputTokens` across the request contract (`AgentTextRequest`, `AgentDecisionRequest`, decision/plan inputs, `TextLogicConfig`, workflow config). Rationale: `AgentTextRequest` is now spread-compatible with the Vercel AI SDK's `generateText`/`streamText` options — an AI SDK host is `generateText({ ...request, model })` plus model-ref resolution.
