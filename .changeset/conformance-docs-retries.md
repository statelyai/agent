---
"@statelyai/agent": minor
---

`recordAiSdk` stamps each recorded model attempt with `aiSdkCall`, the index of the `generateText` or `streamText` call it belongs to. Attempts with the same `aiSdkCall` are one call the code made (its tool-loop steps and the SDK's retries), so a mapping can tell a retry by the SDK (the `retriedBy` attempt has the same `aiSdkCall`) from a resend by the code (a different one), including with `maxRetries: 0` and after the SDK's last attempt. Steps that use a model from `prepareStep` run on the seam's model and carry the same `aiSdkCall`. `recorder.model` now wraps frozen models, and reads metadata getters such as `provider` on the model itself.

The Verify in place guide now checks a run where the code threw with `output`, by recording the throw as the outcome, instead of leaving its outcome unchecked.
