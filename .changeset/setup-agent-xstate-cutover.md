---
"@statelyai/agent": major
---

Make `setupAgent(...)` the package authoring API for XState-native agent machines.

- Remove the legacy `createAgentMachine(...)` builder and the custom local/session runtime surface.
- Remove `@statelyai/agent/local`; runtime is now normal XState actors, snapshots, and `machine.provide({ actors })`.
- Keep model execution transparent: machines invoke well-known text actors with plain XState `invoke`, while hosts provide Vercel AI SDK, LangChain, Workers AI, or custom implementations.
- Add `createAgentSchemas(...)` and `setupAgent(...).withTasks(...)` for schema-first task authoring with typed `invoke.src`, typed invoke input, and typed `onDone.event.output`.
- Add `getAgentEffects(...)`, `doneEvent(...)`, and `transitionResult(...)` for pure XState transition loops where the host/framework owns execution.
- Add task `events` support so model calls can expose whitelisted legal state events as tools.
- Add `parseOutput(...)` for schema-typed model output at assignment boundaries.
- Update graph/XState conversion utilities to consume setupAgent/XState machines directly.
