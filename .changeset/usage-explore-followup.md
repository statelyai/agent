---
"@statelyai/agent": patch
---

`explorePaths` delivers a scripted `@agent.usage` event only when the machine accepts it, as a run does, and a usage transition that restarts the invoke no longer receives the old request's completion.
