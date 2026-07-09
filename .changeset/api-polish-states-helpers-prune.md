---
"@statelyai/agent": minor
---

API polish for alpha:

- `setupAgent({ states })`: per-state context schemas (xstate `setup({ states })`) narrow `context` inside declared states (invoke inputs, transition fns, final outputs), removing defensive `?? default` fallbacks.
- New helpers: `persistSnapshot(snapshot)` (JSON round-trip clone for idle-snapshot persistence) and `bindRequestExecutor(logic, executor)` (bind a child machine's text logic to a raw request executor without casts).
- `createDecisionLogic` removed from the public API. Decisions are state-local: use `src: 'agent.decide'` inline; reuse the input builder function, not an actor (see docs/decisions.md).
- Step vocabulary unified: `getMachineAgentRequests` renamed to `getAgentRequests`; the old hand-passed-options `getAgentRequests` is internal (`getAgentRequestsWith`); `doneEvent`/`transitionResult` are internal. Public step path: `initialAgentStep`, `transitionAgentStep`, `resolveAgentStep`, `getAgentRequests`, `executeAgentRequest`.
- Fixed stale `setupAgent` JSDoc that documented unimplemented result methods.
