---
"@statelyai/agent": patch
---

Events a person sends, and ignored events in traces.

- **`meta: { actor: "human" }` on a transition** means a person sends its event. `agent.decide` and `decideNext` never offer it: a closed choice lists its options in `withheld`, and a choice of it anyway is retried. `getAcceptedEvents(snapshot, { actor: "agent" })` returns the same model-facing list. `describeMachine` marks the transition `(human)`.
- **New lint check `decide-allows-human-event`** (error): a decision's literal `allowedEvents` names a tagged event. `verifyAgentConfig` fails its `lint` gate on it.
- **`machine.transition` trace events carry `ignored: true`** for the host event the state had no transition for, the one `result.ignored` reports. `foldTraces` counts them per state as `ignored`.
