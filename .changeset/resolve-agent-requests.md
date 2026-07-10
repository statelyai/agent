---
"@statelyai/agent": minor
---

Add `resolveAgentRequests(machine, step, executors, options?)`, a step-path helper that collapses the manual host loop. It resolves the current step's pending request — text via `executeAgentRequest` + `resolveAgentStep`, decision via `resolveDecision` (with `canTake` wired to `step.snapshot.can`) + `transitionAgentStep` — and returns the next step, so a complete durable host is `while (!step.done) step = await resolveAgentRequests(machine, step, executors)`. Plan requests are not yet surfaced on the step path.
