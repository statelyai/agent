---
"@statelyai/agent": minor
---

`allowedEvents` (on the `agent.decide` and `agent.plan` builtins) now accepts a single string as well as an array, plus wildcard patterns: `'*'` matches every currently-legal event, and `'ns.*'` matches a dotted namespace (`'todo.*'` → `todo.add`, `todo.toggle`, …). Patterns are typed against the declared dotted event types, so a namespace that matches nothing is a compile error; exact types and patterns can mix (`['todo.*', 'reset']`). Wildcards expand against the live snapshot, so they require a snapshot-aware host (`runAgent` or the step path); under a bare `createActor(...)`, list event types explicitly.
