---
"@statelyai/agent": patch
---

Correct the Verify in place guidance. A run where the code threw is checked with `output`, by recording the throw as the outcome, instead of being left unchecked. When the code retries model calls on its own, a mapping skips only the AI SDK's attempts (`error.data.isRetryable: true`) instead of every effect with `retriedBy`, and the docs name the cases `retriedBy` cannot attribute.
