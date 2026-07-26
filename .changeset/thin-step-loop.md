---
"@statelyai/agent": minor
---

**Removed the step-envelope public API in favor of the thin effect/replay loop.** The `@statelyai/agent/steps` subpath no longer exports the `AgentStep` envelope helpers — `initialAgentStep`, `transitionAgentStep`, `resolveAgentStep`, `resolveAgentRequests` (and `ResolveAgentRequestsOptions`), and `getAgentRequests`, along with the `AgentStep` type. A host now drives an agent machine directly over the append-only journal with `getAgentEffects` + `replay` (the event-log core), resolving each frontier effect itself.

What the subpath now exports: the effect/replay primitives `getAgentEffects`, `replay`, `initEntry` (`+ AGENT_INIT_EVENT_TYPE`, `AgentEffect`, `GetAgentEffectsOptions`, `ReplayOptions`, `ReplayResult`); the per-effect resolvers `executeAgentRequest` (a `text` effect) and `resolveDecision` (a `decision`/`plan` step); the decision helpers `renderDecisionAttempts` / `PLAN_DONE_EVENT_TYPE`; and the request/effect types (`AgentRequest`, `AgentPlanRequest`, `AgentStepRequest`, `AgentTextRequest`, `AgentDecisionRequest`, …).

Two things become host responsibility (the envelope used to bake them in):

- **Concurrency.** `resolveAgentRequests` resolved a step's parallel text requests with `Promise.all` and applied outputs in request-array order. The thin loop resolves one frontier effect per fold; a host that wants concurrency runs `Promise.all` over the frontier's `text` effects and folds the outputs in effect-array order.
- **Plan stepping.** Driving an `agent.plan` invoke (per-step decision request, the applied trail, the four stop reasons) is now a small host loop over the re-surfacing `plan` effect + `resolveDecision`; the applied trail is derived from the journal (it is not folded onto the re-surfaced effect under pure replay).

Migration (a text/decision run):

```ts
// Before
let step = initialAgentStep(machine, input, options);
while (!step.done) step = await resolveAgentRequests(machine, step, executors, options);
return step.snapshot.output;

// After
import { initialTransition, transition } from "xstate";
import { getAgentEffects, executeAgentRequest, resolveDecision, initEntry } from "@statelyai/agent/steps";

const entries = [initEntry(input).event];
let [snapshot, actions] = initialTransition(machine, input);
while (snapshot.status === "active") {
  const effects = getAgentEffects(machine, snapshot, actions, { history: entries, ...options });
  let next;
  for (const effect of effects) {
    if (effect.kind === "execute") { effect.exec(); continue; }
    if (effect.kind === "text") {
      const output = await executeAgentRequest(effect, executors);
      next = effect.toDoneEvent(output); break;
    }
    if (effect.kind === "decision") {
      next = await resolveDecision(effect.request, executors.decide, { canTake: (e) => snapshot.can(e) });
      break;
    }
  }
  if (!next) break; // idle: persist `entries`, resume later via `replay`
  entries.push(next);
  [snapshot, actions] = transition(machine, snapshot, next);
}
return snapshot.output;
```

`runAgent` is unchanged; only the low-level step path moved.
