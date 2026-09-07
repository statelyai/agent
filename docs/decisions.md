---
title: Decisions
description: Let the model choose one currently-legal machine event, validated and retried by the machine before it is taken.
---

> **Alpha:** `@statelyai/agent` 2.0 is in alpha. APIs can change between releases; pin an exact version. Feedback: [github.com/statelyai/agent](https://github.com/statelyai/agent/issues).

## Overview

A **decision** lets the model choose one event to send to the running machine. The machine declares the candidate events, guards determine which of them are legal in the current state, and the model picks one of the remaining candidates. The model does not produce free text or an arbitrary tool call. The machine rejects any event that is not legal in the current state.

The snippets below come from [Twenty Questions](../examples/twenty-questions/index.ts), where the model chooses `ASK` or `GUESS` each turn.

<!-- viz: sequence diagram for one decision: machine invokes agent.decide -> host coerces the model to one candidate event -> validation (unknown-event / invalid-payload / rejected-by-guard) -> retry or send the event to the machine -->

## Invoking an agent decision

<!-- agent.decide builtin from src/setup-agent.ts and src/decision.ts -->

Author a decision inline on the invoke that needs one, using the builtin `agent.decide` actor source. Its input takes:

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
    // Reached when retries are exhausted.
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

The `allowedEvents` list is typed against the machine's user-authored event schema, so a typo is a compile error. Framework events such as `agent.messages` and `@agent.usage` can be handled by the machine but are never model-facing candidates. Listing events explicitly also makes the candidate set visible in the machine.

> **Note:** `agent.decide` needs a snapshot-aware host such as `runAgent` to know which events are currently legal. With a [long-lived actor](choosing-a-run-mode.md#long-lived-actor), list `allowedEvents` explicitly. Wildcards and the omitted default cannot expand there.

### `allowedEvents` patterns

The `allowedEvents` option accepts a single string or an array. Entries are exact event types or wildcard patterns, and the two can mix, as in `['todo.*', 'reset']`.

| Value              | Meaning                                                                                                                                                                                             |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `['ASK', 'GUESS']` | Exact event types, typed against the event-schema keys. A typo is a compile error.                                                                                                                  |
| `'ASK'`            | A single string, shorthand for a one-entry array.                                                                                                                                                   |
| `'*'`              | Every currently-legal event.                                                                                                                                                                        |
| `'todo.*'`         | Every declared event under the `todo.` namespace, such as `todo.add` and `todo.toggle`. Typed against declared dotted types, so a pattern matching nothing, such as `'nope.*'`, is a compile error. |

### Reusable decision logic

<!-- createDecisionLogic public API from src/decision.ts and src/index.ts -->

For a decision used by more than one state or machine, `createDecisionLogic` builds the same decision as standalone actor logic, exported from `@statelyai/agent`. Register the result under `actors:` and invoke it by name. It takes the same fields as the `agent.decide` input, each a static value or an `({ input }) => value` resolver, plus an optional `schemas.input` to type and validate the input.

```ts no-check
import { createDecisionLogic } from "@statelyai/agent";
import { z } from "zod";

export const chooseAction = createDecisionLogic({
  schemas: { input: z.object({ questionsRemaining: z.number() }) },
  model: "quick",
  system: "Ask one yes/no question at a time, but guess on the final turn.",
  prompt: ({ input }) => `Questions remaining: ${input.questionsRemaining}`,
  allowedEvents: ["ASK", "GUESS"],
});
```

Prefer the `agent.decide` builtin for a one-off, state-local decision: it needs no separate declaration and types `allowedEvents` against the machine's own event schemas.

## Delivering the chosen event

Delivery is automatic. When the decision resolves, the `agent.decide` actor sends the chosen event to the machine, and the matching `on:` transition runs. You handle the outcome with ordinary transitions.

### When `onDone` fires

The chosen event's transition usually exits the invoking state, which cancels the invoke, so `onDone` normally never fires. Declare `onDone` only when the chosen event's transition stays in the same state. The invoke then completes with the chosen event as its output. `onError` is unaffected and still fires when retries are exhausted with `AgentDecisionExhaustedError`.

## Guard enforcement

Guards are transition functions that return `undefined`. See [Transitions](machines.md#transitions). A guard may read the event payload, so candidates cannot be filtered before the model picks.

The candidate set is the `allowedEvents` list intersected with the events the state statically accepts. After the model picks one, `snapshot.can(event)` decides whether it is legal in the current snapshot. A chosen `ASK` on the final turn is rejected, and the model is asked again.

`runAgent` performs this check for you. When you call `resolveDecision` directly with a [long-lived actor](choosing-a-run-mode.md#long-lived-actor), pass the check through `canTake`:

```ts
import { resolveDecision } from "@statelyai/agent";

const event = await resolveDecision(request, executors, {
  canTake: (e) => snapshot.can(e),
});
```

## Validation and retries

<!-- decision validation checks and retry behavior from src/decision.ts -->

Each attempt runs three checks in order. Each failure is typed and fed back to the model on the next attempt:

| Failure             | Cause                                                                       |
| ------------------- | --------------------------------------------------------------------------- |
| `unknown-event`     | The event type is not among the candidate events.                           |
| `invalid-payload`   | The payload does not match that event's schema.                             |
| `rejected-by-guard` | The type and payload are valid, but `snapshot.can(event)` returned `false`. |

Retry behavior:

- The default is 2 retries, so up to 3 attempts. Set `maxRetries` on the decide input to change it.
- Prior failed attempts are carried on `request.attempts`, so the host can render the previous failure into the next call. Core does not rewrite the prompt itself. See [Hosts](hosts.md).
- Exhausting retries throws `AgentDecisionExhaustedError`, which carries the attempts list and is caught by the invoke's `onError`.

## Coercion

Core validates and retries. It never calls a model. Coercing the model into choosing exactly one option is the host's responsibility. Hosts do this with one tool per event and a forced tool choice, or with structured output over an event union. The shipped `createAiSdkExecutors` provides a `decide` executor for the Vercel AI SDK. The raw-SDK examples force the choice with `tool_choice`. See [Hosts](hosts.md).

> **Note:** Decisions are state-local, so prefer authoring one-off decisions inline on the invoke.

## The decide loop for multi-event commands

A decision produces one event. When one command needs several events, such as "add X and Y" producing two `ADD_TODO` events, loop the decision in the machine. The loop, its exit, and the trail of applied events stay visible in the statechart.

- A `planning` state invokes `agent.decide` for one event.
- Applying that event targets a turnaround state that immediately re-enters `planning` and starts the next step.
- An explicit machine event, such as `DONE`, is among `allowedEvents` and targets a state outside the loop, so the model can end the loop.
- The trail of applied events lives in context and is appended to each step's prompt.

<!-- viz: state diagram of the decide loop: planning (invoke agent.decide) -> applying (always -> planning) for ADD_TODO/TOGGLE_TODO, and DONE -> awaitingCommand -->

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

Every step runs the validation and retry loop described above. For the full example, see [examples/todo-nl/index.ts](../examples/todo-nl/index.ts).

## Related

- Read more about [Agent machines](machines.md), including transitions, guards, and event schemas.
- Read more about [Hosts](hosts.md), including the decide executor and how the model is coerced into one event.
- Read more about [Machines as data](machines-as-data.md), including authoring decisions from JSON.
