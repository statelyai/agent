---
"@statelyai/agent": minor
---

Simplify the alpha API around a single portable XState machine artifact.

- Add semantic request names/inputs, name-keyed scripted executors, exported type helpers, framework-native `agent.messages` events, typed `appendMessages`, `getInteraction`, `eventFromInteraction`, `isAgentIdle`, `runAgentLoop`, and `runAgentStream`.
- Let `defineModels` provide optional AI SDK executors without adding an AI SDK dependency to core.
- Use native XState persisted snapshots, machine `version`/`migrate`, structural idle states, and framework-owned durability/storage/retry behavior.
- Remove the Agent event log, replay/durable runners, SQLite adapters, implicit request extraction, hidden message state, host idle override, `generateResult`/`createAgentActor`, custom per-state schema sugar, general XState lint rules, and Agent-specific failure status proposal.
- Reduce and rewrite the example/docs catalog around named requests, native snapshots, interactions, evals, and non-trivial state-machine control flow.
