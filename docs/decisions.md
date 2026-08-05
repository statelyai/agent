---
title: Decisions
description: Let the model choose one currently-legal machine event, validated and retried by the machine before it is taken.
---

> **Alpha:** `@statelyai/agent` 2.0 is in alpha. APIs can change between releases; pin an exact version. Feedback: [github.com/statelyai/agent](https://github.com/statelyai/agent/issues).

## Overview

A **decision** lets the model choose an event to send to the running machine. It chooses based on which events are enabled in the current state: the machine declares candidate events, guards decide which are legal, and the model picks among the survivors. Not free text, not an arbitrary tool call; an out-of-bounds choice is impossible, not merely discouraged by a prompt.

The snippets below are from [Twenty Questions](../examples/twenty-questions/index.ts), where each turn the model chooses `ASK` or `GUESS`.

## Invoking an agent decision

<!-- agent.decide builtin from src/setup-agent.ts and src/decision.ts -->

Author a decision inline with the builtin `agent.decide` actor source, on the invoke that needs one. Its input takes:

- `model`: which model to use (a key from your models map).
- `system` (optional): system prompt.
- `prompt` (optional): user prompt, usually built from `context`.
- `allowedEvents` (optional): the candidate events (exact types or [patterns](#allowedevents-patterns)). Defaults to all currently-legal events.
- `maxRetries` (optional): retries after an invalid choice. Default 2.

```ts no-check
// ...
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
    // The model never made a valid choice (retries exhausted).
    onError: { target: 'failed' },
  },
  on: {
    ASK: ({ context, event }) =>
      context.questionsRemaining > 1 ? { target: 'awaitingAnswer', context: { /* ... */ } } : undefined,
    GUESS: ({ context, event }) => ({ target: 'revealing', context: { guess: event.guess } }),
  },
}
// ...
```

The `allowedEvents` list is strongly typed against the machine's event schema, so a typo is a compile error. Listing events explicitly also makes the candidate set reviewable in the machine.

> **Note:** `agent.decide` needs a **snapshot-aware host** (`runAgent` or the [step path](steps.md)) to know which events are currently legal. Under a bare `createActor(...)`, list `allowedEvents` explicitly; wildcards and the omitted default cannot expand there.

> **Note:** `allowedEvents` narrows the _declared_ candidates; guards then decide what is actually legal from the current snapshot. A declared-but-currently-illegal choice does not get through.

### `allowedEvents` patterns

The `allowedEvents` option accepts a single string or an array. Entries are exact event types or wildcard patterns, and the two can mix (`['todo.*', 'reset']`):

- `['ASK', 'GUESS']`: exact types, typed against the event-schema keys (typo = compile error).
- `'ASK'`: a single string, shorthand for a one-entry array.
- `'*'`: every currently-legal event.
- `'todo.*'`: a dotted namespace, every declared event under `todo.` (`todo.add`, `todo.toggle`, …). Typed against declared dotted types, so `'nope.*'` (matching nothing) is a compile error.

## Delivering the chosen event

Delivery is automatic: when the decision resolves, the `agent.decide` actor sends the chosen event to the machine, and the matching `on:` transition runs. You handle the outcome with ordinary transitions, no special decision plumbing.

> **Note:** The chosen event's transition typically exits the invoking state, cancelling the invoke, so `onDone` normally never fires. Declare `onDone` only when the chosen event's transition stays in-state; the invoke then completes with the chosen event as output. `onError` (retries exhausted, `AgentDecisionExhaustedError`) is unaffected.

## Guard enforcement

A candidate event's guard is its transition function returning `undefined` (see [transitions](machines.md#transitions)). Before accepting a choice, the library checks `snapshot.can(event)`, so a chosen `ASK` on the final turn (guard returns `undefined`) is rejected and the model asked again. The machine, not the prompt, is the source of truth for legality.

Guards may read the event payload, so candidates cannot be filtered upfront: a decision offers the full `allowedEvents` set (intersected with what the state statically accepts), and legality is checked **after** the model picks. `runAgent` and the step path handle this for you. When calling `resolveDecision` directly (uncontrolled mode), thread the check via `canTake`:

```ts
import { resolveDecision } from "@statelyai/agent";

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
- Prior failed attempts ride on `request.attempts`, so the host can render "your last choice failed because X" into the next call. Core never rewrites the prompt itself; see [Hosts](hosts.md).
- Exhausting retries throws `AgentDecisionExhaustedError` (carrying the attempts list), caught by the invoke's `onError`.

## Coercion

Core validates and retries; it never talks to a model. Coercing the model into choosing exactly one option (tool-per-event with forced tool choice, structured output over an event union, etc.) is the host's responsibility. The shipped `createAiSdkExecutors` provides a `decide` executor for the Vercel AI SDK; the raw-SDK examples force the choice with `tool_choice`. See [Hosts](hosts.md).

> **Note:** Decisions are state-local: author them inline on the invoke. There is no reusable decision-logic object, because a decision's candidates and legality depend on the state it runs in.

## Multi-event commands: the decide loop

A decision is one event. When one command needs several ("add X and Y" → two `ADD_TODO`), loop the decision in the machine — the loop, its exit, and the applied trail stay visible in the statechart:

- A `planning` state invokes `agent.decide` for **one** event.
- Applying that event targets a turnaround state that immediately re-enters `planning`, starting the next step.
- An explicit machine event (e.g. `DONE`) is among `allowedEvents` and targets somewhere outside the loop, so the model can end it.
- The trail of applied events lives in context and is appended to each step's prompt.

```ts no-check
planning: {
  invoke: {
    src: 'agent.decide',
    input: ({ context }) => ({
      model: 'quick',
      prompt: `${context.command}\n\nAlready applied: ${context.applied.join(', ')}`,
      allowedEvents: ['ADD_TODO', 'TOGGLE_TODO', 'DONE'],
    }),
  },
  on: {
    ADD_TODO: ({ context, event }) => ({
      target: 'applying',
      context: { applied: [...context.applied, `ADD_TODO ${event.title}`] },
    }),
    DONE: { target: 'awaitingCommand' },
  },
},
applying: { always: { target: 'planning' } },
```

Every step gets this page's validation/retry loop. Full example: [examples/todo-nl/index.ts](../examples/todo-nl/index.ts).

## Where to go next

- [Agent machines](machines.md): transitions, guards, and event schemas.
- [Hosts](hosts.md): the decide executor and how the model is coerced into one event.
- [Machines as data](machines-as-data.md): authoring decisions from JSON.
