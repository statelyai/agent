---
"@statelyai/agent": patch
---

`checkCrashRecovery` takes `sendDuring` (host events sent while a named effect, or its `occurrence`-th start, is in flight, and redelivered after a crash when the log lost them) and `timers: "host"` (the harness hosts root `after` timers on a virtual clock; an id-less `{ type: "xstate.timer" }` in `events` fires the soonest). A `sendDuring` key the run never starts, or `events` left undelivered, now throw.

Fix: a model call (text, decision, or fill) whose invoke is stopped while it waits for the journal write no longer reaches the executor, so a cancel that lands in the same step costs no tokens.

Fix: a plain actor at the root waits for the journal like a model call does, so the event that started it is durable before its side effect runs.

`runAgent`'s `onIdle` may return a host timer firing (`{ type: "xstate.timer", id }`).
