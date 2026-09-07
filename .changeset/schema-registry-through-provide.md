---
"@statelyai/agent": patch
---

Registered schemas now survive `machine.provide(...)`. `runAgent` starts its actor from a rebound machine, so `parseAgentEvent(result.snapshot, ...)` and `getInteraction(result.snapshot)` found no schemas and skipped validation: a bad payload passed through unchecked, and a choice whose payload the schema says is incomplete was judged against an `undefined` field. The registry is now keyed on the machine's root `config` as well as the machine object — `config` is shared by reference across `.provide` — so a result snapshot resolves the same pack `setupAgent` registered. `getAgentSchemas` reads through the same fallback.
