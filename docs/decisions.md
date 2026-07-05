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

## Reusable decision logic

<!-- createDecisionLogic from src/decision.ts and examples/game-agent -->

When a decision is reusable, exported, or worth testing standalone, pull it out with `createDecisionLogic` and register it under `actorSources:`. The game-agent example exports `chooseMove` and computes `allowedEvents` as a function of input, gating `HEAL` on the player's HP:

```ts
import { createDecisionLogic } from '@statelyai/agent';

export const chooseMove = createDecisionLogic({
  schemas: { input: z.object({ playerHp: z.number(), enemyHp: z.number() }) },
  model: 'moveChooser',
  system: 'You are playing a turn-based game. Choose exactly one legal move.',
  prompt: ({ input }) => `Player HP: ${input.playerHp}\nEnemy HP: ${input.enemyHp}`,
  allowedEvents: ({ input }) =>
    input.playerHp <= 6
      ? ['ATTACK', 'DEFEND', 'HEAL', 'FLEE']
      : ['ATTACK', 'DEFEND', 'FLEE'],
});
```

```ts
const gameSetup = setupAgent({ schemas: gameSchemas, models, actorSources: { chooseMove } });

// ...in the machine:
choosingMove: {
  invoke: {
    id: 'chooseMove',
    src: 'chooseMove',
    input: ({ context }) => ({ playerHp: context.playerHp, enemyHp: context.enemyHp }),
    onDone: sendDecision(),
    onError: { target: 'fumbled' },
  },
  on: {
    ATTACK: ({ context }) => ({ target: 'summarizing', context: { /* ... */ } }),
    HEAL: ({ context, event }) => ({ target: 'summarizing', context: { /* ... */ } }),
    // ...
  },
}
```

When the player is above 6 HP, `HEAL` is not offered at all. See [examples/game-agent/index.ts](../examples/game-agent/index.ts).

> **Note:** Use inline `agent.decide` for a one-off, state-local decision. Reach for `createDecisionLogic` when the same decision is reused across states or machines, or you want to unit-test it on its own.

## Where to go next

- [Agent machines](machines.md): transitions, guards, and event schemas.
- [Hosts](hosts.md): the decide executor and how the model is coerced into one event.
- [Machines as data](machines-as-data.md): authoring decisions from JSON.
