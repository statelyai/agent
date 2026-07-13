---
title: The step path
description: Drive an agent machine one model call at a time so a durable host can checkpoint after every step.
---

## Why it exists

The **step path** is a set of helpers that advance an agent machine one transition at a time, handing you a plain, persistable checkpoint after every model call. It is the durable-host counterpart to [runAgent](hosts.md), not a lesser version of it.

`runAgent` checkpoints only when the run settles (`done`, `idle`, `error`). That is enough for most hosts, but not for Cloudflare Workflows, Temporal, or anything that must resume from the last model call rather than the last settle. For those hosts, drive the loop yourself.

## Why this runs anywhere

The step path works in any host (Temporal, Workflows, serverless, a queue consumer, a plain server) because of one property: **every step helper is a pure, synchronous function.** `initialAgentStep`, `transitionAgentStep`, and `resolveAgentStep` never await, never do IO, and always return the same step for the same inputs. All asynchrony lives in your code, between steps.

That split is the whole durability story:

- The host journals each async result (model output, actor result, timer firing) in its own runtime as its own activity.
- Replay is deterministic: re-applying the journaled events through the pure transitions reconstructs the exact snapshot, so a crashed run resumes without re-billing model calls.
- Nothing async hides inside a transition, so there is nothing the host cannot checkpoint around.

The flip side: because transitions are pure, **the host must execute everything async itself.** There are exactly three kinds:

1. **Model requests** (`step.requests`): text requests via `executeAgentRequest`, decisions via `resolveDecision`. The loop below.
2. **Plain actors** (a non-model `invoke`, like a send-email side effect): these do **not** appear in `step.requests`. They surface in `step.actions` as spawn actions carrying `id`, `src`, and `input`. The host runs the effect in its own runtime, then feeds the result back with `resolveAgentStep(machine, step, id, output)`.
3. **Delayed transitions** (`after`): schedulable raise actions in `step.actions`; the host owns the clock (see below).

A step with `requests: []` and `done: false` therefore means one of two things: the machine is **idle** waiting for an external event (a human reply: persist the snapshot and resume later with `transitionAgentStep`), or a **plain actor or timer is pending** in `step.actions` and the host must execute it. Check `step.actions` to tell them apart; do not treat empty requests as done or as an error.

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
  actorSources: gameActors,
});

while (!step.done) {
  const [request] = step.requests;
  if (!request) {
    // Idle (waiting for an external event) or a plain actor/timer is
    // pending in step.actions. Persist the snapshot and leave the loop;
    // resume later with transitionAgentStep (see "Why this runs anywhere").
    break;
  }

  if (request.kind === 'decision') {
    const chosenEvent = await resolveDecision(request, decide, {
      canTake: (event) => step.snapshot.can(event),
    });
    step = transitionAgentStep(gameMachine, step, chosenEvent, {
      schemas: gameSchemas,
      actorSources: gameActors,
    });
    continue;
  }

  const output = await executeAgentRequest(request, executors);
  step = resolveAgentStep(gameMachine, step, request, output, {
    schemas: gameSchemas,
    actorSources: gameActors,
  });
}

console.log(step.snapshot.output);
```

### One-line loop with `resolveAgentRequests`

The dispatch above — pick the pending request, branch on `kind`, resolve it, advance — is the same every turn. `resolveAgentRequests` collapses it into one call: it resolves the current step's pending request (decision or text) and returns the next step, wiring `canTake` to `step.snapshot.can` for you. A complete durable host is two lines:

```ts
import { initialAgentStep, resolveAgentRequests } from '@statelyai/agent';

let step = initialAgentStep(gameMachine, input, { schemas: gameSchemas, actorSources: gameActors });
while (!step.done) {
  step = await resolveAgentRequests(gameMachine, step, executors, { schemas: gameSchemas, actorSources: gameActors });
}

console.log(step.snapshot.output);
```

Reach past it to the manual dispatch (shown above) when a host must interleave its own work between the request and the transition — per-turn persistence, one serverless invocation per turn, or a plain actor/timer pending in `step.actions`. `resolveAgentRequests` throws a clear error if the executor a request needs (`generateText`/`streamText` or `decide`) is missing. It also drives **plan** requests natively (see [Plans on the step path](#plans-on-the-step-path)) and resolves a step's pending text requests concurrently (see [Concurrent text requests](#concurrent-text-requests)).

See [examples/ai-sdk-game-host/index.ts](../examples/ai-sdk-game-host/index.ts) for the full loop, and [Decisions](decisions.md) for the validate-and-retry rules.

> **Note:** `executeAgentRequest` is text-only; passing a `kind: 'decision'` request throws. A decision has no output value to feed into `resolveAgentStep`; it produces a chosen event applied with `transitionAgentStep`.

### The floor: no executors at all

`executeAgentRequest` and `resolveDecision` are conveniences, not requirements. A `kind: 'text'` request carries everything needed (`model` ref, `system`, `prompt`, `messages`, `tools`, `outputSchema`, `maxOutputTokens`); call any API yourself and feed the result back:

```ts
const text = await yourOwnFetch(request);
step = resolveAgentStep(machine, step, request, text);
```

For decisions, `request.events` carries the candidates (`type`, `toolName`, payload `inputSchema`). Pick an event however you like (your own model call, a rules engine, a human) and apply it with `transitionAgentStep`; guards still reject illegal events. `resolveDecision` remains available a la carte when you want its validate-and-retry loop (`canTake: (e) => step.snapshot.can(e)`).

The full ladder: `runAgent` (owns the loop), `resolveAgentRequests` (one call per iteration), raw step helpers with executors, raw step helpers with your own code, the machine as pure oracle.

## The AgentStep shape

Each `step` is a plain, inspectable object:

- **`snapshot`**: the machine's current snapshot
- **`actions`**: the executable actions that produced it
- **`requests`**: pending model work, a `kind`-discriminated union (`'text' | 'decision' | 'plan'`)
- **`done`**: whether a final state was reached

A durable host persists this after every model call. Every request kind is plain data, so a host can serialize a request, schedule the model call in its own runtime, and resume the loop later. `transitionAgentStep` accepts a raw snapshot or a whole prior step as its second argument.

## Plans on the step path

An [`agent.plan`](decisions.md#plans-multi-event-decisions) invoke applies an ordered *sequence* of legal events — each one a decision — rather than a single one. On the step path it surfaces as a `kind: 'plan'` request that **re-surfaces on every step** while the plan is in flight (unlike text/decision requests, which surface once and resolve once):

```ts
interface AgentPlanRequest {
  kind: 'plan';
  id: string;
  src: string;
  input: AgentPlanInput;          // model, system, prompt, allowedEvents, stopOn, maxSteps
  events: AgentEventDescriptor[]; // legal machine candidates + the reserved agent.plan.done move
  applied: ChosenEvent[];         // the trail so far
  stepsRemaining: number;         // maxSteps - applied.length
}
```

The protocol per step: resolve **one** decision from `events` (with `resolveDecision`, wiring `canTake` to `step.snapshot.can` exactly like a single decision), then apply it. A real machine event advances the plan — the *next* step re-surfaces the request with an updated `applied`/`events`/`stepsRemaining`. The reserved `agent.plan.done` move, a `stopOn` event, an exhausted budget, or no legal events **completes** the plan: its invoke resolves with `{ steps, stopped }` (`stopped` is `'done' | 'stop-event' | 'max-steps' | 'no-legal-events'`), fed back like any invoke result. An applied event that exits the invoking state cancels the plan (its `onDone` never fires) — identical to `runAgent`.

`resolveAgentRequests` does all of this for you, one plan step (one decision, or one completion) per call — so the two-line durable host loop drives plans unchanged:

```ts
let step = initialAgentStep(machine, input);
while (!step.done) step = await resolveAgentRequests(machine, step, executors);
```

**Crash-safe mid-plan.** `agent.plan` is a stateful, transition-based *ledger* actor: its in-progress state (the `applied` trail and remaining budget) is the invoke child's own snapshot `context`, advanced one event at a time. So it lands in a machine's persisted snapshot for free —

```
children.plan1.snapshot.context = { applied: ChosenEvent[], stepsRemaining: number, stopped: string | null }
```

— surviving a full `getPersistedSnapshot` → JSON → restore round-trip. A host that persists after every event and reloads resumes the plan identically:

```ts
// persist mid-plan
const json = JSON.stringify(machine.getPersistedSnapshot(step.snapshot));
// ...later, in a fresh process...
const snapshot = createActor(machine, { snapshot: JSON.parse(json) }).getSnapshot();
let step = {
  snapshot,
  actions: [],
  requests: getAgentRequests(machine, [], snapshot),
  done: snapshot.status === 'done',
};
while (!step.done) step = await resolveAgentRequests(machine, step, executors);
```

## Concurrent text requests

Parallel machine regions can leave **multiple pending text requests** on one step. Because parallel statechart regions are genuinely concurrent, `resolveAgentRequests` resolves them all in parallel (`Promise.all`) and applies their outputs in **request-array order** — deterministic for durable replay regardless of which model call finishes first. This is the default (and only) behavior; no flag:

```ts
step = await resolveAgentRequests(machine, step, executors);
```

Only text requests are batched. **Decisions and plans stay one at a time**: applying either changes the set of legal candidates for what follows, so they cannot be resolved against a stale snapshot.

A host that instead wants strictly sequential text resolution loops the manual per-request helpers (`executeAgentRequest` + `resolveAgentStep`) one request at a time.

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
