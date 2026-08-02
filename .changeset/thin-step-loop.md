---
"@statelyai/agent": minor
---

**Dropped the `AgentStep` envelope in favor of the thin effect/replay loop.** A host now drives an agent machine directly over the append-only journal with `getAgentEffects` + `replay`, resolving each frontier effect itself — no opaque step object in between.

No longer public: `initialAgentStep`, `transitionAgentStep`, `resolveAgentStep`, `resolveAgentRequests` (and `ResolveAgentRequestsOptions`), `getAgentRequests`, and the `AgentStep` type. They remain internal implementation detail.

What you use instead (all on the root barrel, since `/steps` is gone too): the effect/replay primitives `getAgentEffects`, `replay`, `initEntry`, `createReplayEntry` (`+ AGENT_INIT_EVENT_TYPE`, `AgentEffect`, `GetAgentEffectsOptions`, `ReplayOptions`, `ReplayResult`); the per-effect resolvers `executeAgentRequest` (a `text` effect) and `resolveDecision` (a `decision`/`plan` step); the decision helpers `renderDecisionAttempts` / `PLAN_DONE_EVENT_TYPE`; and the request/effect types.

Two things become host responsibility (the envelope used to bake them in):

- **Concurrency.** `resolveAgentRequests` resolved a step's parallel text requests with `Promise.all` and applied outputs in request-array order. The thin loop resolves one frontier effect per fold; a host that wants concurrency runs `Promise.all` over the frontier's `text` effects and folds the outputs in effect-array order.
- **Plan stepping.** Driving an `agent.plan` invoke (per-step decision request, the applied trail, the four stop reasons) is a small host loop over the re-surfacing `plan` effect + `resolveDecision`. The applied trail is derived from the journal — it is not folded onto the re-surfaced effect under pure replay.

Migration (a text/decision run):

```ts
import { initialTransition, transition } from "xstate";
import {
  createReplayEntry, executeAgentRequest, getAgentEffects, initEntry, resolveDecision,
} from "@statelyai/agent";

const entries = [initEntry(machine, input)];
let [snapshot, actions] = initialTransition(machine, input);
while (snapshot.status === "active") {
  const effects = getAgentEffects(machine, snapshot, actions, { history: entries });
  let next;
  for (const effect of effects) {
    if (effect.kind === "execute") { effect.exec(); continue; }
    if (effect.kind === "text") {
      next = effect.toDoneEvent(await executeAgentRequest(effect, executors));
      break;
    }
    if (effect.kind === "decision") {
      next = await resolveDecision(effect.request, executors.decide!, {
        canTake: (event) => snapshot.can(event),
      });
      break;
    }
  }
  if (!next) break; // idle: persist `entries`, resume later via `replay`
  entries.push(createReplayEntry(machine, entries, next));
  [snapshot, actions] = transition(machine, snapshot, next);
}
return snapshot.output;
```

`runAgent` is unchanged; only the low-level step path moved.
