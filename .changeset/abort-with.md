---
"@statelyai/agent": patch
---

`abortWith: { event, timeout? }` on `runAgent`/`createAgentRuntime` routes `signal`'s abort through the machine: the event is sent into the run and the run continues until the machine settles. Falls back to `cause: "aborted"` when the machine does not handle the event or `timeout` elapses.
