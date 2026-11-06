---
"@statelyai/agent": patch
---

`runAgent`: whether an ignored event came from the `inbox` is tracked per pass by its source, so an ignored `onIdle` answer that reuses an event object once sent through the inbox ends the loop instead of being retried.
