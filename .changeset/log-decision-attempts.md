---
"@statelyai/agent": minor
---

**Decision attempts in the event log.** The log now keeps the decision attempts the machine did not accept, on the entry they explain, so a decider can be improved from its traces:

- An `agent.decide` invoke that lands after failed tries records them on the delivered event's entry as `entry.attempts`.
- A decision that exhausts its retries keeps `attempts` on its `xstate.error.actor` entry's normalized `error`.
- A host that decides with `decideNext` passes its `attempts` with the event: `runToQuiescence(runtime, { event, attempts })` (or `runAgent(machine, { event, attempts })`), or `runtime.transition(state, event, { attempts })` in a host-owned loop.
- `getDecisionAttempts(entries)` in `@statelyai/agent/log` lists them as `{ index, eventType, attempts }[]`.

Replay ignores both fields, and logs written before them replay unchanged. `AGENT_EVENT_SCHEMA_VERSION` stays `1`: `assertAgentLogEntry` already accepted unknown envelope fields, so older readers accept the new ones.
