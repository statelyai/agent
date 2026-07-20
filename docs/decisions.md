---
title: Decisions
description: Let the model choose exactly one currently-legal machine event, validated and retried by the machine before it is taken.
---

> **Alpha:** `@statelyai/agent` 2.0 is in alpha. APIs can change between releases; pin an exact version. Feedback: [github.com/statelyai/agent](https://github.com/statelyai/agent/issues).

## Overview

A **decision** is the model choosing exactly one currently-legal machine event. Not free text, not an arbitrary tool call. The machine declares candidate events, its guards decide which are legal from the current state, and the model picks among the survivors. An out-of-bounds choice is impossible, not merely discouraged by a prompt.

Twenty Questions is the running example: each turn the model chooses `ASK` or `GUESS`. See [examples/twenty-questions/index.ts](../examples/twenty-questions/index.ts).

## The inline `agent.decide` invoke

<!-- agent.decide builtin from src/setup-agent.ts and src/decision.ts -->

Author a decision inline with the builtin `agent.decide` actor source, on the invoke that needs one. Give it a `model`, optional `system` and `prompt`, and optional `allowedEvents`:

```ts
deciding: {
  invoke: {
    id: 'chooseAction',
    src: 'agent.decide',
    input: ({ context }) => ({
      model: 'quick',
      system: 'Ask one yes/no question at a time, but guess on the final turn.',
      prompt: `Questions remaining: ${context.questionsRemaining}`,
      allowedEvents: ['ASK', 'GUESS'],
    }),
    onError: { target: 'stumped' },  // retries exhausted
  },
  on: {
    ASK: ({ context, event }) =>
      context.questionsRemaining > 1 ? { target: 'awaitingAnswer', context: { /* ... */ } } : undefined,
    GUESS: ({ context, event }) => ({ target: 'revealing', context: { guess: event.guess } }),
  },
}
```

`allowedEvents` is typed against the machine's event-schema keys, so a typo is a compile error. It is optional: omit it to default to all currently-legal events (needs a snapshot-aware host, see [patterns](#allowedevents-patterns) below). Listing events explicitly buys the typo check and makes the candidate set reviewable in the machine.

> **Note:** `allowedEvents` narrows the _declared_ candidates; guards then decide what is actually legal from the current snapshot. A declared-but-currently-illegal choice does not get through.

### `allowedEvents` patterns

`allowedEvents` (on both `agent.decide` and `agent.plan`) accepts a single string or an array. Entries are exact event types or wildcard patterns:

- `['ASK', 'GUESS']`: exact types, typed against the event-schema keys (typo = compile error).
- `'ASK'`: a single string, shorthand for a one-entry array.
- `'*'`: every currently-legal event.
- `'todo.*'`: a dotted namespace, every declared event under `todo.` (`todo.add`, `todo.toggle`, …). Typed against declared dotted types, so `'nope.*'` (matching nothing) is a compile error.

Patterns and exact types can mix (`['todo.*', 'reset']`). Wildcards expand against the live snapshot, so they need a **snapshot-aware host** (`runAgent` or the step path); under a bare `createActor(...)`, list event types explicitly.

`matchesEventPattern(eventType, pattern): boolean` is the exported helper behind this, for a host checking whether an event type matches an `allowedEvents` pattern.

## Delivering the chosen event

Delivery is automatic. When the decision resolves, the chosen event is sent to the invoking actor. It lands in `on:` as if a user had sent it: a chosen `ASK` runs the `ASK` transition, a chosen `GUESS` runs the `GUESS` transition. You handle the outcome with ordinary transitions, not special decision plumbing.

That transition typically **exits** the invoking state (`ASK` → `awaitingAnswer`, `GUESS` → `revealing`), cancelling the invoke, so `onDone` normally never fires. (Same as `agent.plan`, where exiting the state ends the plan.)

`onDone` is optional and rarely needed: declare it only when the chosen event's transition stays **in-state**, so the invoke completes and `onDone` observes the chosen event as output. `onError` (retries exhausted → `DecisionExhaustedError`) is unaffected.

## Guard enforcement

A candidate event's guard is its transition function returning `undefined` (see [transitions](machines.md#transitions)). Before accepting a choice, `resolveDecision` checks `snapshot.can(event)`, so a chosen `ASK` on the final turn (guard returns `undefined`) is rejected and the model asked again. The machine, not the prompt, is the source of truth for legality.

Guards may read the event payload, so candidates cannot be filtered upfront: a decision offers the full `allowedEvents` set (intersected with what the state statically accepts), and legality is checked **after** the model picks. `getAcceptedEvents(snapshot)` therefore returns candidates unfiltered by payload-dependent guards. `runAgent` and the step path handle this for you. Calling `resolveDecision` directly (uncontrolled mode), thread the check via `canTake`:

```ts
const event = await resolveDecision(request, executors.decide, {
  canTake: (e) => snapshot.can(e),
});
```

## Validation and retries

<!-- decision validation checks and retry behavior from src/decision.ts -->

Each attempt runs three checks in order. Each failure is typed and fed back to the model on the next attempt:

- **`unknown-event`**: the type is not among the candidate events.
- **`invalid-payload`**: the payload does not match that event's schema.
- **`rejected-by-guard`**: type and payload are fine, but `snapshot.can(event)` returned `false`.

Retry behavior:

- Default 2 retries, so up to 3 attempts. Set `maxRetries` on the decide input to change it.
- Prior failed attempts ride on `request.attempts`, so a host adapter can render "your last choice failed because X" into the next call. Core never rewrites the prompt itself; `renderDecisionAttempts(request)` is the exported helper that renders the attempts list into feedback messages (used by both shipped adapters and the raw-SDK example hosts).
- Exhausting retries throws `DecisionExhaustedError` (carrying the attempts list), caught by the invoke's `onError`. In Twenty Questions, that routes to a `stumped` final state instead of crashing the run.

## Coercion

Core validates and retries; it never talks to a model. How the model is coerced into choosing exactly one option (tool-per-event with forced tool choice, structured output over an event union, etc.) is host business. The shipped `createAiSdkExecutors` provides a `decide` executor for the Vercel AI SDK; the raw-SDK examples force the choice with `tool_choice`. See [Hosts](hosts.md).

## Reusable decisions

Decisions are state-local: author them inline on the invoke with `src: 'agent.decide'`. There is no reusable decision-logic object.

To reuse a decision across states or machines, share the **input builder** (the `({ context }) => ({ model, system, prompt, allowedEvents })` function), not an actor or logic object. Each state passes it to its own `agent.decide` invoke.

```ts
const chooseMoveInput = ({ context }) => ({
  model: 'quick',
  system: 'You are playing a turn-based game. Choose exactly one legal move.',
  prompt: `Player HP: ${context.playerHp}\nEnemy HP: ${context.enemyHp}`,
  allowedEvents: ['ATTACK', 'DEFEND', 'FLEE'],
});
```

Each reusing state points its invoke at the shared builder: `invoke: { src: 'agent.decide', input: chooseMoveInput, onError: { target: 'fumbled' } }`.

## Plans (multi-event decisions)

A decision is one event; a **plan** is many. The `agent.plan` builtin iterates a decision against the live snapshot, applying legal events one at a time until the model decides to stop. Every step gets this page's validation/retry loop. See [Plans](plans.md).

## Where to go next

- [Agent machines](machines.md): transitions, guards, and event schemas.
- [Plans](plans.md): the multi-event form, `agent.plan`.
- [Hosts](hosts.md): the decide executor and how the model is coerced into one event.
- [Machines as data](machines-as-data.md): authoring decisions from JSON.
