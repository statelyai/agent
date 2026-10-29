---
"@statelyai/agent": patch
---

`info.callKey` is distinct for calls inside an invoked child machine. Such a call names the child's path (`<executionId>:<childId>/<requestId>#<n>`), so a resumed thread no longer restarts every child call at `#1`. A call key's `n` is now the invocation's ordinal at its site in a fold of the log, cancelled invocations included, so a call re-entered after a cancel no longer takes the cancelled call's key after a crash.
