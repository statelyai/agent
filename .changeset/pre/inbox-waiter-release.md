---
"@statelyai/agent": patch
---

`runAgent`: an `inbox.send` that lands just after an `onIdle` answer wins the idle race is queued for the next pass instead of being dropped.
