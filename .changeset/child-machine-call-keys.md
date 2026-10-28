---
"@statelyai/agent": patch
---

`info.callKey` is distinct for calls inside an invoked child machine. Such a call is keyed under the root-level child that owns it (`<executionId>:<childId>#<m>/<requestId>#<k>`), so a resumed thread no longer restarts every child call at `#1`, and a crash re-run of a child keeps its keys.
