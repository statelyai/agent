---
"@statelyai/agent": minor
---

One way to do each thing. Removed APIs and their replacements:

- `runToQuiescence(createAgentRuntime(machine, options), init)` → `runAgent(machine, { ...options, ...init })`. `createAgentRuntime` stays for hosts that write their own loop.
- `createAgentSchemas(...)` and `setupAgent({ schemas })` → pass the fields to `setupAgent({ context, events, input, output, ... })`. To share a schema set, keep it in a plain object and spread it. A `setupAgent` call without `events` now declares no custom events (as a `createAgentSchemas` pack already did), so sending an undeclared event is a type error.
- `assertAgentMachine(machine, options)` → `lintAgentMachine(machine, { ...options, throw: true })`.
- `inspectTransitions(handler)` → an `inspect` handler that checks `event.type === "@xstate.transition"`.
- `parseOutput(schema, value)` → the request's `onDone` output is already validated; elsewhere, validate with the schema itself.
- `bindRequestExecutor(logic, executor)` → `logic.withExecutor(...)`, or `provideExecutors`, which also binds child machines.
- `WithAgentUsageEvent` → `WithAgentEvents`.
- The preset factories in `@statelyai/agent/machines` are removed. The examples show each shape as an ordinary machine (`prompt-chaining`, `agent-supervisor`, `swarm-handoff`, `map-reduce`, `review-tool-calls`).
- `@statelyai/agent/log` no longer exports `rebindActorSession`, `agentCallOccurrence`, `validateReplayEntries`, `getSnapshotStateHash`, `AGENT_EVENT_SCHEMA_VERSION` or `AGENT_INIT_EVENT_TYPE`.

Fixes:

- A machine whose reached final state has no `output` no longer reports another final state's output.
- Under `runAgent`/`createAgentRuntime`, a decision that carries its own executor (`withExecutor`) runs itself instead of being replaced by the host's `decide`. A decision inside a child machine sees the child's event schemas, and a decision bound twice keeps its declared `allowedEvents`.
