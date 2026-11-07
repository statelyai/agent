---
"@statelyai/agent": patch
---

`checkCrashRecovery` takes `sendDuring`, host events sent while a named effect is in flight and redelivered after a crash when the log lost them, and `timers: "host"`, which makes the harness the host scheduler for root `after` timers.

Fix: a model call (text, decision, or fill) whose invoke is stopped while it waits for the journal write no longer reaches the executor, so a cancel that lands in the same step costs no tokens.
