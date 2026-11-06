---
"@statelyai/agent": patch
---

`runAgent`: an `inbox.send` made synchronously inside `onIdle` now resumes the run instead of hanging it.
