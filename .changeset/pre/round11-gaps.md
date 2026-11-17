---
"@statelyai/agent": patch
---

Add `createGeneratorBridge` for carving a loop whose public surface is an async generator: an actor forwards each pass's values to the consumer one pull at a time, with `.throw()` and `.return()` forwarded back. `checkParity` and `wrapWorkflow().run` take `recordOptions` per effect (`serialize`, `revive`, `redact`).
