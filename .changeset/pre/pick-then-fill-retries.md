---
"@statelyai/agent": patch
---

Retry a `'pick-then-fill'` fill that fails the event's schema. The fill call asks for the schema's shape without validating it, so `resolveDecision` records a payload that fails as an `invalid-payload` attempt, feeds the reason back, and retries within `maxRetries` instead of throwing the adapter's structured-output error (the AI SDK's `NoObjectGeneratedError`). The pick also describes each event type with its event schema's description when no option describes it, so a language model sees it in the choice and a decision model such as Jev gets it as the criterion instead of the event as JSON.
