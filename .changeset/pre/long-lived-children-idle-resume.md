---
"@statelyai/agent": minor
---

Long-lived invoked children now work with the idle/resume host path:

- `runAgent` idle detection no longer treats an invoked child machine that is itself idle (waiting for events, no busy descendants, no pending eventless/after work) as in-flight work, so machines with a long-lived invoked agent can settle idle instead of hanging.
- Idle results always include `persistedSnapshot` (previously only alongside pending user inputs). Resume from it — `runAgent(machine, { snapshot: result.persistedSnapshot, event })` — to restore invoked children with their accumulated state; resuming from the live `snapshot` restarts children fresh.
