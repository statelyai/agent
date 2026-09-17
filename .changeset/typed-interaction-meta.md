---
"@statelyai/agent": minor
---

State `meta` is typed by default. `setupAgent` now types every state's `meta` as `AgentInteractionMeta` keyed by the machine's declared events (exported as `AgentDefaultMeta`), so a `meta.interaction` choice or `textEvent` naming an undeclared event is a compile error, with no `meta` schema to pass. A machine that declares its own `meta` schema replaces the default. `AgentInteractionDescriptor` and `AgentInteractionMeta` take the event-type union as a type parameter.
