---
title: Decisions
description: Let the model choose exactly one currently-legal machine event, validated and retried by the machine before it is taken.
---

## Overview

A **decision** is the model choosing exactly one currently-legal machine event. Not free text, not an arbitrary tool call. The machine declares the candidate events, its guards decide which are actually legal from the current state, and the model picks among the survivors. Because the model can only ever produce a legal event, an out-of-bounds choice is impossible rather than merely discouraged by a system prompt.

Twenty Questions is the running example: each turn, the model chooses `ASK` or `GUESS`. See [examples/twenty-questions/index.ts](../examples/twenty-questions/index.ts).

## The inline `agent.decide` invoke

<!-- agent.decide builtin and sendDecision from src/setup-agent.ts and src/decision.ts -->

Author a decision inline with the builtin `agent.decide` actor source, right on the invoke that needs one. Give it a `model`, an optional `system` and `prompt`, and `allowedEvents`:

```ts
deciding: {
  invoke: {
    id: 'chooseAction',
    src: 'agent.decide',
    input: ({ context }) => ({
      model: 'quick',
      system: 'Ask one yes/no question at a time, but guess on the final turn.',
      prompt: `Questions remaining: ${context.questionsRemaining}`,
      allowedEvents: ['ASK', 'GUESS'] as const,
    }),
    onDone: sendDecision(),          // delivers the chosen event into this state's `on:`
    onError: { target: 'stumped' },  // retries exhausted
  },
  on: {
    ASK: ({ context, event }) =>
      context.questionsRemaining > 1
        ? { target: 'awaitingAnswer', context: { /* ... */ } }
        : undefined,
    GUESS: ({ context, event }) => ({
      target: 'revealing',
      context: { guess: event.guess },
    }),
  },
}
```

`allowedEvents` is typed against the machine's event-schema keys, so a typo'd event name is a compile error. Omit it to default to all currently-legal events.

> **Note:** `allowedEvents` narrows the *declared* candidates; guards then decide what is actually legal from the current snapshot. A declared-but-currently-illegal choice does not get through.

## Delivering the chosen event

`sendDecision()` is the transition function for the decide invoke's `onDone`. The chosen event lands in `on:` exactly as if a user had sent it: a chosen `ASK` runs the `ASK` transition, a chosen `GUESS` runs the `GUESS` transition. You handle the outcome with ordinary transitions, not special decision plumbing.

## Guard enforcement

The guard for a candidate event is its transition function: returning `undefined` makes it illegal. Before accepting a choice, `resolveDecision` checks `snapshot.can(event)`:

```ts
on: {
  // On the final turn this returns `undefined`, so a chosen ASK is rejected.
  ASK: ({ context, event }) =>
    context.questionsRemaining > 1
      ? { target: 'awaitingAnswer', context: { /* ... */ } }
      : undefined,
  GUESS: ({ context, event }) => ({ target: 'revealing', context: { guess: event.guess } }),
}
```

The model cannot force an illegal transition. If it chooses `ASK` on the final turn, the choice is rejected and the model is asked again. The machine, not the prompt, is the source of truth for what is legal.

## Validation and retries

<!-- decision validation checks and retry behavior from src/decision.ts -->

Each attempt runs three checks in order. Each failure is typed and fed back to the model on the next attempt:

- **`unknown-event`**: the type is not among the candidate events.
- **`invalid-payload`**: the payload does not match that event's schema.
- **`rejected-by-guard`**: type and payload are fine, but `snapshot.can(event)` returned `false`.

Details:

- Default 2 retries, so up to 3 attempts. Set `maxRetries` on the decide input to change it.
- Prior failed attempts ride on `request.attempts`, so a host adapter can render "your last choice failed because X" into the next call. Core never rewrites the prompt itself.
- Exhausting retries throws `DecisionExhaustedError` (carrying the attempts list), caught by the invoke's `onError`. In Twenty Questions, that routes to a `stumped` final state instead of crashing the run.

## Coercion

Core validates and retries; it never talks to a model. How the model is coerced into choosing exactly one option (tool-per-event with forced tool choice, structured output over an event union, or anything else) is host business. The shipped `createAiSdkExecutors` provides a `decide` executor for the Vercel AI SDK; the raw-SDK examples force the choice with `tool_choice`. See [Hosts](hosts.md).

## Reusable decisions

Decisions are state-local: author them inline on the invoke with `src: 'agent.decide'`. There is no reusable decision-logic object.

To reuse one decision across states or machines, share the **input builder** — the `({ context }) => ({ model, system, prompt, allowedEvents })` function — not an actor or logic object. Each state passes it to its own `agent.decide` invoke.

```ts
const chooseMoveInput = ({ context }) => ({
  model: 'quick',
  system: 'You are playing a turn-based game. Choose exactly one legal move.',
  prompt: `Player HP: ${context.playerHp}\nEnemy HP: ${context.enemyHp}`,
  allowedEvents: ['ATTACK', 'DEFEND', 'FLEE'] as const,
});
```

```ts
// ...in the machine, reused across states:
choosingMove: {
  invoke: {
    id: 'chooseMove',
    src: 'agent.decide',
    input: chooseMoveInput,
    onDone: sendDecision(),
    onError: { target: 'fumbled' },
  },
  on: {
    ATTACK: ({ context }) => ({ target: 'summarizing', context: { /* ... */ } }),
    DEFEND: ({ context, event }) => ({ target: 'summarizing', context: { /* ... */ } }),
    // ...
  },
}
```

`allowedEvents` declares which machine events the model may choose from; guards then filter to the ones actually legal from the current snapshot.

## Plans (multi-event decisions)

<!-- agent.plan builtin from src/decision.ts and createRunAgentPlanLogic in src/run-agent.ts -->

A **decision** is one event. A **plan** is many: the `agent.plan` builtin iterates a decision against the live snapshot, applying legal events one at a time until it decides to stop. Use it when a single command maps to several events ("add X and Y" → two `ADD_TODO`).

Author it inline with `src: 'agent.plan'`, same shape as `agent.decide` plus `stopOn` and `maxSteps`:

```ts
planning: {
  invoke: {
    src: 'agent.plan',
    input: ({ context }) => ({
      model: 'quick',
      prompt: renderCommand(context),
      allowedEvents: ['ADD_TODO', 'TOGGLE_TODO', 'NOTHING', 'QUIT'] as const,
      stopOn: ['NOTHING'] as const,   // sentinel that ends the plan
      maxSteps: 8,                    // hard cap (default 8)
    }),
    onDone: { target: 'awaitingCommand' },  // output: { steps, stopped }
  },
  on: {
    ADD_TODO: ({ context, event }) => ({ context: { /* ... */ } }),
    NOTHING: {},                 // no-op transition; declare it even as `{}`
    QUIT: { target: 'done' },    // exiting the state ends the plan (see below)
  },
}
```

How it behaves:

- **Iterated decide.** Each step re-reads the live snapshot, so candidates always reflect everything applied so far. Each step runs the same validation/retry loop a single decision gets — a guard-rejected step retries with `rejected-by-guard` feedback (see [Validation and retries](#validation-and-retries)).
- **`stopOn` sentinels.** Events listed in `stopOn` end the loop once chosen. They bypass the guard check, so declare the target as a plain no-op transition (`NOTHING: {}`) — this gives the model an explicit "done / no action needed" move.
- **`maxSteps`** caps the plan (default 8). Also stops when no legal candidate remains.
- **Applied trail** is appended to the prompt automatically each step, so the model sees plan progress without you threading it through context.
- **Exiting the state ends the plan.** An applied event that leaves the invoking state (e.g. `QUIT` above) cancels the invoke — xstate moves on and `onDone` never runs.
- **Partial application, no rollback.** Events are sent to the machine as the plan runs, not staged. If step 3 of 5 stops the plan, steps 1–2 already applied and stay applied. There is no transactional undo.
- **`onDone` output** is `{ steps, stopped }` — the events applied in order, and why the loop ended (`'stop-event' | 'max-steps' | 'no-legal-events'`).
- **`runAgent`-only for now.** Applying events mid-invoke needs a live parent actor, which only a snapshot-aware host has. The step-loop path doesn't drive `agent.plan` yet; provide a custom `actorSources['agent.plan']` if you need it elsewhere.

Full example: [examples/todo-nl/index.ts](../examples/todo-nl/index.ts) drives free-text commands through one `agent.plan` invoke.

## Where to go next

- [Agent machines](machines.md): transitions, guards, and event schemas.
- [Hosts](hosts.md): the decide executor and how the model is coerced into one event.
- [Machines as data](machines-as-data.md): authoring decisions from JSON.
