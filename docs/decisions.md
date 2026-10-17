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
- `name` (optional): the request's semantic name. It identifies the decision in traces, host mocks, and eval scripts. Without it the name falls back to the invoke `id`, then to the invoke's state path. See [Plain-function executors](evals.md#plain-function-executors).
- `system` (optional): system prompt.
- `prompt` (optional): user prompt, usually built from `context`.
- `allowedEvents` (optional): the candidate events (exact types or [patterns](#allowedevents-patterns)). Defaults to all currently-legal events.
- `maxRetries` (optional): retries after an invalid choice. Default 2.

```ts no-check
// ...
deciding: {
  invoke: {
    src: 'agent.decide',
    input: ({ context }) => ({
      model: 'quick',
      name: 'chooseAction',
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

The `allowedEvents` list is typed against the machine's user-authored event schema, so a typo is a compile error. Framework events such as `@agent.usage` can be handled by the machine but are never model-facing candidates. Listing events explicitly also makes the candidate set visible in the machine.

> **Note:** `agent.decide` needs a snapshot-aware host such as `runToQuiescence` to know which events are currently legal. With a [long-lived actor](choosing-a-run-mode.md#long-lived-actor), list `allowedEvents` explicitly. Wildcards and the omitted default cannot expand there.

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

`runToQuiescence` performs this check for you. When you call `resolveDecision` directly with a [long-lived actor](choosing-a-run-mode.md#long-lived-actor), pass the check through `canTake`:

```ts
import { resolveDecision } from "@statelyai/agent";

const event = await resolveDecision(request, executors, {
  canTake: (e) => snapshot.can(e),
});
```

Build the request with `createDecisionRequest` rather than by hand. It fills in `kind`, an `id`, an empty `attempts` list, and each candidate event's `toolName`, and accepts either bare event types or the descriptors `getAcceptedEvents` returns:

```ts no-check
const request = createDecisionRequest({
  name: "judge",
  model: "reviewer",
  prompt: `Judge this draft.\n\n${snapshot.context.draft}`,
  events: getAcceptedEvents(snapshot),
});
```

## Validation and retries

<!-- decision validation checks and retry behavior from src/decision.ts -->

Each attempt runs three checks in order. Each failure is typed and fed back to the model on the next attempt:

| Failure             | Cause                                                                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `unknown-event`     | The event type is not among the candidate events.                                                                                                      |
| `invalid-payload`   | The payload does not match that event's schema.                                                                                                        |
| `rejected-by-guard` | The type and payload are valid, but `snapshot.can(event)` returned `false`, or the event matches none of a [closed choice](#closed-choices)'s options. |

Retry behavior:

- The default is 2 retries, so up to 3 attempts. Set `maxRetries` on the decide input to change it.
- Prior failed attempts are carried on `request.attempts`, so the host can render the previous failure into the next call. Core does not rewrite the prompt itself. See [Hosts](hosts.md).
- Exhausting retries throws `AgentDecisionExhaustedError`, which carries the attempts list and is caught by the invoke's `onError`.
- The run's [event log](event-log.md) keeps the failed attempts on the entry they explain. `getDecisionAttempts` reads them back. See [Decision attempts](event-log.md#decision-attempts).

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

## Closed choices

By default the model writes the event payload. A **closed choice** lists the concrete events instead, and the model picks one.

- Pass `payloads` on the `agent.decide` input: one payload list per event type, without `type`.
- Each payload becomes one option on `request.options`.
- An event type in `allowedEvents` with no `payloads` key is offered bare, as `{ type }`. An empty list offers nothing for that type. To withhold a type, give it `[]`: `payloads: { refund: [{ amount: 20 }], escalate: [] }`.
- The runtime keeps only the options `snapshot.can(event)` accepts right now.
- The chosen event must equal one offered option, type and payload. Any other choice is retried as a `rejected-by-guard` attempt.

```ts
import { createAgentSchemas, setupAgent } from "@statelyai/agent";
import { z } from "zod";

const agent = setupAgent({
  schemas: createAgentSchemas({
    context: z.object({ limit: z.number() }),
    events: { refund: z.object({ amount: z.number() }), escalate: z.object({}) },
  }),
});

agent.createMachine({
  context: { limit: 50 },
  initial: "deciding",
  states: {
    deciding: {
      invoke: {
        src: "agent.decide",
        input: {
          model: "quick",
          allowedEvents: ["refund", "escalate"],
          // The model sees refund 20 and escalate. The machine does not accept refund 80.
          payloads: { refund: [{ amount: 20 }, { amount: 80 }] },
        },
      },
      on: {
        refund: ({ context, event }) =>
          event.amount <= context.limit ? { target: "refunded" } : undefined,
        escalate: { target: "escalated" },
      },
    },
    refunded: {},
    escalated: {},
  },
});
```

### Closed choices with the AI SDK

- `createAiSdkExecutors` presents a closed choice as ONE tool, `choose_option`, instead of one tool per event.
- Its input is `{ option }`, an enum of option ids such as `refund:20` and `escalate`. The tool description lists each id with its description.
- The chosen id maps back to that option's event.
- An id that is not offered, or a call to another tool, is retried as an `unknown-event` attempt. Its reason names the answer and lists the valid ids.

### Decision models

`createDecisionModelDecide` from `@statelyai/agent/ai-sdk` backs `decide` with an AI SDK decision model, such as TypeSafe's Jev, through `experimental_decide`.

- It asks one `choice` question. Each option id is a label, and its description is the criterion.
- The state is `request.input`, or the result of the `state` option.
- A label that is not an option is retried as an `unknown-event` attempt, like any failed choice.
- With `minConfidence`, a choice below that confidence throws a low-confidence error instead of answering. The throw is the escalation signal, not a retry: route it through the invoke's `onError`, or catch it at the boundary.
- A request without options throws: a decision model answers closed choices only.

```ts
import { createDecisionModelDecide } from "@statelyai/agent/ai-sdk";
import type { Experimental_DecisionModel } from "ai";

declare const judge: Experimental_DecisionModel;

const decide = createDecisionModelDecide(judge, { minConfidence: 0.6 });
```

## Decisions at the boundary of a plain machine

A machine does not have to know about AI. `decideNext` asks a model to pick one event that a plain XState machine accepts right now, built with `createMachine` or `setup`, with no `agent.*` invoke anywhere.

- `events`: exact types or wildcards such as `'desk.*'`. Candidates are the matching events an active state handles.
- `payloads` (optional): a function of the snapshot returning payloads per event type, as in a closed choice. A candidate type with no key is offered bare, as `{ type }`. An empty list offers nothing for that type, so `{ "desk.escalate": [] }` withholds it.
- Options are kept only where `snapshot.can(event)` is true. Each one is described by its transition's `description`, else its event schema's description.
- `lookahead` (optional): appends what each option changes, computed with xstate's pure `transition()`: the state value and the changed top-level context keys.
  - `true` reports every changed key, each value cut at 120 characters.
  - `{ keys, maxLength }` reports only the listed context keys, each value cut at `maxLength`. A state value change is always reported.
- With no options, it returns `{ event: null }` without calling the executor.
- It never sends. The host sends the event, after checking `can` again, because the actor may have moved while the model was choosing.

```ts
import { decideNext } from "@statelyai/agent";
import { createAiSdkExecutors } from "@statelyai/agent/ai-sdk";
import { openai } from "@ai-sdk/openai";
import { createActor, createMachine } from "xstate";
import { z } from "zod";

const desk = createMachine({
  schemas: {
    context: z.object({ requested: z.number(), limit: z.number() }),
    events: {
      "desk.refund": z.object({ amount: z.number() }),
      "desk.escalate": z.object({}).describe("Hand the case to a person"),
    },
  },
  context: { requested: 20, limit: 50 },
  initial: "reviewing",
  states: {
    reviewing: {
      on: {
        "desk.refund": {
          description: "Refund the customer",
          to: ({ context, event }) =>
            event.amount <= context.limit ? { target: "refunded" } : undefined,
        },
        "desk.escalate": { target: "escalated" },
      },
    },
    refunded: {},
    escalated: {},
  },
});

const { decide } = createAiSdkExecutors({ models: { quick: openai("gpt-5.4-mini") } });
const actor = createActor(desk);

let busy = false;
actor.subscribe(async (snapshot) => {
  if (busy || !snapshot.matches("reviewing")) return;
  busy = true;
  try {
    const { event } = await decideNext(snapshot, {
      decide,
      model: "quick",
      events: "desk.*",
      payloads: (s) => ({ "desk.refund": [{ amount: s.context.requested }] }),
      lookahead: true,
    });
    if (event && actor.getSnapshot().can(event)) actor.send(event);
  } finally {
    busy = false;
  }
});
actor.start();
```

The result also carries `attempts`, the failed choices before the one that landed, and the `request` the executor saw. Exhausting retries throws `AgentDecisionExhaustedError`. To journal `attempts`, pass them with the event to the run that delivers it. See [Boundary decisions](event-log.md#boundary-decisions).

## Related

- Read more about [Agent machines](machines.md), including transitions, guards, and event schemas.
- Read more about [Hosts](hosts.md), including the decide executor and how the model is coerced into one event.
- Read more about [Machines as data](machines-as-data.md), including authoring decisions from JSON.
