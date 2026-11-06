---
"@statelyai/agent": patch
---

Inspection: `runAgent` and `createAgentRuntime` now hand an `inspect` callback one stable actor handle per session, announced once. Before, the durable runtime re-created actor objects each step under the same `sessionId`, so `@statelyai/sdk`'s inspector reported duplicate ids and showed no snapshots. The docs' `createInspector` recipe now works as written; it awaits `inspector.ready` before printing the URL.
