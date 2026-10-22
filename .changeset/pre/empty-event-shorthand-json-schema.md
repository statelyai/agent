---
"@statelyai/agent": patch
---

Events declared with the `{}` shorthand in `setupAgent({ events: { APPROVE: {} } })` now convert to an empty-object JSON Schema when offered to a model. Listing one under `agent.decide({ allowedEvents })` with `createAiSdkExecutors` previously failed with "Standard schema vendor 'statelyai-agent' does not support JSON Schema conversion."
