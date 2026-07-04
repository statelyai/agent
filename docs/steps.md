---
title: The step path
description: Drive an agent machine one model call at a time so a durable host can checkpoint after every step.
---

## Why it exists

The **step path** is a set of helpers that advance an agent machine one transition at a time, handing you a plain, persistable checkpoint after every model call. It is the durable-host counterpart to [runAgent](hosts.md), not a lesser version of it.

`runAgent` checkpoints only when the run settles (`done`, `idle`, `error`). That is enough for most hosts, but not for Cloudflare Workflows, Temporal, or anything that must resume from the last model call rather than the last settle. For those hosts, drive the loop yourself.

## The step loop

<!-- step helpers (initialAgentStep, resolveAgentStep, transitionAgentStep, executeAgentRequest) from src/steps.ts; running example examples/ai-sdk-game-host -->

`initialAgentStep` starts a machine and returns its first step. Loop until `step.done`:

- A **decision** request goes through `resolveDecision` (wire `canTake` to `step.snapshot.can` so guard-rejected choices are caught and retried), then `transitionAgentStep` applies the chosen event.
- A **text** request goes through `executeAgentRequest`, then `resolveAgentStep` feeds the output back.

```ts
import {
  executeAgentRequest,
  initialAgentStep,
  resolveAgentStep,
  resolveDecision,
  transitionAgentStep,
} from '@statelyai/agent';

let step = initialAgentStep(gameMachine, input, {
  schemas: gameSchemas,
  actors: gameActors,
});

while (!step.done) {
  const [request] = step.requests;
  if (!request) {
    throw new Error('Machine is waiting without an agent request.');
  }

  if (request.kind === 'decision') {
    const chosenEvent = await resolveDecision(request, decide, {
      canTake: (event) => step.snapshot.can(event),
    });
    step = transitionAgentStep(gameMachine, step, chosenEvent, {
      schemas: gameSchemas,
      actors: gameActors,
    });
    continue;
  }

  const output = await executeAgentRequest(request, executors);
  step = resolveAgentStep(gameMachine, step, request, output, {
    schemas: gameSchemas,
    actors: gameActors,
  });
}

console.log(step.snapshot.output);
```

See [examples/ai-sdk-game-host/index.ts](../examples/ai-sdk-game-host/index.ts) for the full loop, and [Decisions](decisions.md) for the validate-and-retry rules.

> **Note:** `executeAgentRequest` is text-only; passing a `kind: 'decision'` request throws. A decision has no output value to feed into `resolveAgentStep`; it produces a chosen event applied with `transitionAgentStep`.

## The AgentStep shape

Each `step` is a plain, inspectable object:

- **`snapshot`**: the machine's current snapshot
- **`actions`**: the executable actions that produced it
- **`requests`**: pending text/decision work, a `kind`-discriminated union (`'text' | 'decision'`)
- **`done`**: whether a final state was reached

A durable host persists this after every model call. Both request kinds are plain data, so a host can serialize a request, schedule the model call in its own runtime, and resume the loop later. `transitionAgentStep` accepts a raw snapshot or a whole prior step as its second argument.

## Delayed transitions

An `after` does not run on a live timer here. It surfaces in `step.actions` as a **schedulable raise action**, and the host owns the clock: schedule the delay with a Workflow sleep, a Temporal timer, or a queue delay, then apply the event with `transitionAgentStep` when it fires.

## Steps as an event log

Think of the step path as event sourcing:

- Each step applies exactly one event: a machine transition, a resolved text result, or a decision's chosen event.
- Persisting the ordered **event log**, not just the latest snapshot, is what makes replay and audit possible.
- A snapshot is a compaction checkpoint, not the source of truth.

This is why the step helpers hand back plain objects rather than owning a live actor: the host decides what to persist, when, and where.

## Related

- [Hosts and executors](hosts.md): the executor functions the step loop calls.
- [Human in the loop](human-in-the-loop.md): idle states and resuming from a persisted snapshot.
