---
"@statelyai/agent": major
---

Breaking: `setupAgent({ actorSources })` rename and open model refs.

- **`setupAgent({ actors })` is now `setupAgent({ actorSources })`.** The config key that registers actor source implementations is renamed to match XState v6's `setup({ actorSources })` and the already-correct `machine.provide({ actorSources })` / `runAgent(machine, { actorSources })`. The step-helper options key is renamed the same way: `initialAgentStep`/`transitionAgentStep`/`resolveAgentStep`/`getMachineAgentRequests`/`getAgentRequests` now take `{ actorSources }` instead of `{ actors }`. The runtime collision guard between `actorSources` and `requests` keeps working, with an updated message. Agent-object properties such as `agent.requests` are unchanged.
- **Model refs are open strings.** A request's `model:` field accepts any string. When a `models` map is registered its keys still autocomplete, but any other string is legal (`AgentModelRef` widened to `(keyof TModels & string) | (string & {})`). The `models` map is optional; refs are opaque routing keys resolved by the host or the AI SDK adapter (its `models` map or `resolveModel`). Identity-map ceremony (`const models = { "x": "x" } as const`) is no longer needed for bare refs.
