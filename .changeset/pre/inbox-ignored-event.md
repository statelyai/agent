---
"@statelyai/agent": patch
---

`runAgent`: an ignored `inbox` event no longer ends the `onIdle` loop; only an ignored opening event or `onIdle` answer does.
