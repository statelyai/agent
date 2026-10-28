---
"@statelyai/agent": patch
---

`info.callKey` is distinct for calls inside an invoked child machine. Such a call names the child's path (`<executionId>:<childId>/<requestId>#<n>`) and counts that site's completions in the child's own journaled entries, so a resumed thread no longer restarts every child call at `#1`, and a crash re-run keeps its key.
