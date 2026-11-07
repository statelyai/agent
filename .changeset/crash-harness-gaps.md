---
"@statelyai/agent": patch
---

`checkCrashRecovery` takes `sendDuring`, host events sent while a named effect is in flight and redelivered after a crash when the log lost them, and `timers: "host"`, which makes the harness the host scheduler for root `after` timers.
