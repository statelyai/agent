---
"@statelyai/agent": minor
---

Remove the `agent.plan` builtin; use an explicit `agent.decide` loop (see todo-nl example).

A multi-event command is now authored as a loop in the machine: a `planning` state invokes `agent.decide` for one event, applying it re-enters `planning` for the next step, and an explicit machine event (e.g. `DONE`) exits the loop. The applied trail lives in context and is appended to each step's prompt. Control flow stays visible in the statechart.

Removed: the `agent.plan` invoke src, `PLAN_DONE_EVENT_TYPE`, `PlanLogic`, `AgentPlanInput`, `AgentPlanOutput`, `AgentPlanRequest`, and the `kind: 'plan'` request/effect/usage variants.
