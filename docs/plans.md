---
title: Plans
description: Iterate a decision against the live snapshot, applying legal events one at a time until the model decides to stop.
---

> **Alpha:** `@statelyai/agent` 2.0 is in alpha. APIs can change between releases; pin an exact version. Feedback: [github.com/statelyai/agent](https://github.com/statelyai/agent/issues).

## Overview

<!-- agent.plan builtin from src/decision.ts and createRunAgentPlanLogic in src/run-agent.ts -->

A [decision](decisions.md) is one event. A **plan** is many: the `agent.plan` builtin iterates a decision against the live snapshot, applying legal events one at a time until it decides to stop. Use it when a single command maps to several events ("add X and Y" → two `ADD_TODO`).

Every step gets the same legality guarantees as a single decision: candidates come from the machine, guards reject illegal choices, rejected choices retry with typed feedback.

## Authoring

Author it inline with `src: 'agent.plan'`, same shape as `agent.decide` plus `stopOn` and `maxSteps`:

```ts no-check
// inside states: { ... }
planning: {
  invoke: {
    src: 'agent.plan',
    input: ({ context }) => ({
      model: 'quick',
      prompt: renderCommand(context),
      allowedEvents: ['ADD_TODO', 'TOGGLE_TODO', 'QUIT'],
      maxSteps: 8,                    // hard cap (default 8)
    }),
    onDone: { target: 'awaitingCommand' },  // output: { steps, stopped }
  },
  on: {
    ADD_TODO: ({ context, event }) => ({ context: { /* ... */ } }),
    QUIT: { target: 'done' },    // exiting the state ends the plan (see below)
  },
}
```

The `allowedEvents` list accepts the same exact-type and wildcard forms as `agent.decide`; see [`allowedEvents` patterns](decisions.md#allowedevents-patterns).

## Plan behavior

- **Iterated decide.** Each step re-reads the live snapshot, so candidates reflect everything applied so far, and runs the same validation/retry loop a single decision gets. A guard-rejected step retries with `rejected-by-guard` feedback (see [Validation and retries](decisions.md#validation-and-retries)).
- **Built-in done move.** Every step is offered a reserved `agent.plan.done` candidate (`PLAN_DONE_EVENT_TYPE`). Choosing it ends the plan (`stopped: 'done'`) and is never sent to the machine, so the machine needs no no-op sentinel of its own. The library hints this move in the prompt automatically.
- **`maxSteps`** caps the plan (default 8). Also stops when no legal candidate remains.
- **Applied trail** is appended to the prompt automatically each step, so the model sees progress without you threading it through context.
- **Exiting the state ends the plan.** An applied event that leaves the invoking state (e.g. `QUIT` above) cancels the invoke; xstate moves on and `onDone` never runs.
- **Partial application, no rollback.** See the warning below.
- **`onDone` output** is `{ steps, stopped }`: the events applied in order, and why the loop ended (`'done' | 'stop-event' | 'max-steps' | 'no-legal-events'`).
- **`stopOn` (rare).** For "send this real machine event **and** stop", list it in `stopOn`: the event is validated and sent, then the loop ends (`stopped: 'stop-event'`). The built-in done move covers the common "no further action" case, so `stopOn` is only for ending on an actual state change.
- **Survives persist/resume.** `runAgent` holds the in-progress plan as the invoke child's own snapshot `context` (`{ applied, stepsRemaining, stopped }`), so a persisted snapshot captures it at `children.<id>.snapshot.context` and a plan can resume mid-run. On the [step path](steps.md#plans) the same plan re-surfaces as a `kind: 'plan'` effect each frontier: the host resolves one decision per frontier and derives the applied trail from the event log (see [Plans](steps.md#plans)).

> **Warning: partial application, no rollback.** Events are sent as the plan runs, not staged. If step 3 of 5 stops the plan, steps 1–2 stay applied. There is no transactional undo, so make each event safe to leave applied on its own.

Full example: [examples/todo-nl/index.ts](../examples/todo-nl/index.ts) drives free-text commands through one `agent.plan` invoke.

## Where to go next

- [Decisions](decisions.md): the single-event form, validation, retries, and coercion.
- [The step path](steps.md#plans): plans as re-surfacing `kind: 'plan'` effects with crash-safe mid-plan resume.
- [Verify](verify.md): plan branches in model-free simulation.
