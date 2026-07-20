---
"@statelyai/agent": patch
---

`runAgent`'s `inspect` option now accepts an observer object (`{ next }`) as
well as a function, matching `createActor`. `@statelyai/inspect`'s
`inspector.inspect` now plugs in directly: `runAgent(machine, { inspect: inspector.inspect })`.
