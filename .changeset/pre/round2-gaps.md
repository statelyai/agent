---
"@statelyai/agent": patch
---

**Fixes from a second round of real-repo ports.**

- **Each decision gets its own `callKey`.** A decision usually ends by sending its chosen event, which exits the state before its invoke completes, so the log held no completion to count. Every turn at a decision site got `#1`, and a crash re-run got the completed call's key. The chosen event's entry now records the call it settles as `entry.decidedBy` (`<requestId>#<n>`), and `agentCallOccurrence` counts it.
- **`traceCoverage` counts states an `always` transition passes through as visited.** It re-derives each step's microsteps with XState's `getMicrosteps`; a step it cannot recompute adds none.
- **`NormalizedEventSchemas` is exported,** so a module that exports a machine factory built on `createAgentSchemas` events emits declarations without TS2742/TS2883.
- **The OpenAI text tool loop no longer throws or returns `""` on a bad tool call.** A call to a tool the request did not offer, or arguments that are not JSON, goes back to the model as an error result, as a thrown tool does.
