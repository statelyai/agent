---
"@statelyai/agent": minor
---

**`decideNext` reports what the guards blocked.** The result has `withheld: ChosenEvent[]`: every `allowedEvents` type and payload, built like the offered options, that `snapshot.can(event)` rejected. It is filled when nothing is offered too. `AgentDecisionRequest.withheld` holds the same list, and a closed choice under the runtime (`agent.decide` with `payloads`) sets it as well, so a decision's `request.start` trace shows it.
