---
title: Agent machines
description: Author an agent machine as a typed XState state machine that decides what your agent can do, while the host executes model calls.
---

> **Alpha:** `@statelyai/agent` 2.0 is in alpha. APIs can change between releases; pin an exact version. Feedback: [github.com/statelyai/agent](https://github.com/statelyai/agent/issues).

## Overview

An **agent machine** is a typed XState state machine describing what your agent can do: which states exist, which transitions are legal, which model calls happen, and which events the model may choose right now. It is a blueprint; it never talks to a model directly.

Author a machine in three steps:

1. Declare a models registry and your `context`/`input`/`output`/`events` schema fields.
2. Pass them to `setupAgent` with your requests and actor sources.
3. Build with `agentSetup.createMachine`.

## Declare schemas

<!-- flat schema fields on setupAgent from src/setup-agent.ts -->

Pass your schema fields directly to `setupAgent` to type the machine's context, event payloads, input, output, and state meta:

- `context` (required), `input`, `output`: context, input, and output shapes.
- `events`: per-event payload types (see below).
- `meta`: typed state/transition metadata.

Every schema is a [Standard Schema](https://standardschema.dev) (Zod, Valibot, ArkType, or a hand-written validator), retained on the agent for runtime validation, so context and events are typed without `{} as Type` casts.

```ts
import { z } from "zod";
import { setupAgent } from "@statelyai/agent";

const agentSetup = setupAgent({
  models,
  context: z.object({ prompt: z.string(), answer: z.string().nullable() }),
  input: z.object({ prompt: z.string() }),
  output: z.object({ answer: z.string() }),
});
```

To keep conversation history in context, add a `messages` field via `messagesSchema` or the `z.custom<AgentMessage[]>` recipe (see [messages](messages.md#a-lightweight-messages-field)).

**Event schemas** type event payloads. Declare one schema per event type under `events`:

```ts
// setupAgent({ ... })
events: {
  ATTACK: z.object({ target: z.string().default('goblin') }),
  HEAL: z.object({ amount: z.number().min(1).max(8).default(4) }),
  FLEE: {},
},
// ...
```

In a `HEAL` transition, `event.amount` is a `number`; reading a field the event does not carry is a compile error. Write `{}` for a payload-less event.

**Emitted event schemas** type the progress events a machine emits with `enq.emit(...)`, received by hosts via [`runAgent`'s `on` handlers](hosts.md#observation-callbacks). Declare them under `emitted`:

```ts
// setupAgent({ ... })
emitted: {
  EVALUATED: z.object({ qualityScore: z.number(), iteration: z.number() }),
},
// ...
```

Both `enq.emit({ type: 'EVALUATED', ... })` and the host-side `on: { EVALUATED: handler }` are then typed; an undeclared type or wrong payload is a compile error.

> **Sharing a schema pack.** To reuse one schema set across machines or the step helpers, declare it once with `createAgentSchemas({ context, input, output, events })` and pass it as `setupAgent({ schemas })`. Equivalent to the inline form. See [Which authoring form when](#which-authoring-form-when).

## Set up the agent

<!-- setupAgent config surface (models, requests, actors, builtins) from src/setup-agent.ts -->

Beyond schemas, `setupAgent` takes your models plus optional `requests` and `actors`, and returns a **setup** whose `createMachine` builds the machine. Like XState's `setup()`, the return value is the typed foundation, not a running agent, so name it accordingly (`agentSetup`, `gameSetup`).

- The builtins `agent.generateText`, `agent.streamText`, `agent.decide`, `agent.plan`, `agent.userInput` are registered automatically; invoke them by name.
- Prefer inline schema fields; reach for the `createAgentSchemas` pack form only to share one schema set. See [Which authoring form when](#which-authoring-form-when).

### Models

The `models` map pairs a short alias with a resolved model. When present, request and decision `model:` values are typed against its keys (a typo is a compile error), and app code shares one alias map between `setupAgent` and the host adapter.

```ts
import { openai } from "@ai-sdk/openai";
import { defineModels } from "@statelyai/agent/ai-sdk";

const models = defineModels({
  quick: openai("gpt-5.4-mini"),
  careful: openai("gpt-5.4"),
});

const agentSetup = setupAgent({
  models,
  context, input, output,
  requests: {
    answerQuestion: {
      schemas: { input: z.object({ prompt: z.string() }), output: answerSchema },
      model: "quick", // typed as "quick" | "careful"
      prompt: ({ input }) => input.prompt,
    },
  },
});
```

Aliases are optional: a request can carry any `model:` string (like `'openai/gpt-5.4-mini'`) that the host resolves at run time. See [Which authoring form when](#which-authoring-form-when) and [Hosts](hosts.md).

### Requests

The `requests` map declares named text requests inline. Each entry carries its own input/output schemas, a model, and a `prompt` (or `messages`) built from typed input, and becomes an actor you invoke by its key.

```ts
// setupAgent({ ... })
requests: {
  classifyAnswer: {
    schemas: {
      input: z.object({ question: z.string(), rawAnswer: z.string() }),
      output: z.object({ answer: z.enum(["yes", "no"]) }),
    },
    model: "quick",
    system: "Classify a natural-language answer as yes or no.",
    prompt: ({ input }) => `Q: ${input.question}\nA: ${input.rawAnswer}`,
  },
},
// ...
```

See [Text requests](text-requests.md) for the full request surface, including streaming and structured output.

### Actors

The `actors` map registers reusable actor logic: text logic from `createTextLogic`, or any XState actor. Register logic here when it is reusable, exported, or worth testing standalone. Decisions are state-local (`src: 'agent.decide'`), not actor sources; to reuse one, share its input builder.

```ts
import { createTextLogic } from "@statelyai/agent";

const summarizeTurn = createTextLogic({
  schemas: { input: z.object({ log: z.string() }), output: z.string() },
  model: "quick",
  prompt: ({ input }) => `Summarize this turn:\n${input.log}`,
});

const agentSetup = setupAgent({
  models,
  context: z.object({ log: z.string(), summary: z.string().nullable() }),
  input: z.object({ log: z.string() }),
  actors: { summarizeTurn },
});
```

> **Warning:** Actor source keys must be unique across `actors` and `requests`. `setupAgent` throws at setup time on a collision rather than letting one silently shadow the other.

## Create the machine

The `agentSetup.createMachine` method is XState's `createMachine` with the agent's schemas and actors already bound. It registers the machine so the step helpers and [`runAgent`](hosts.md) resolve its schemas and actors without re-passing them.

```ts
const machine = agentSetup.createMachine({
  context: ({ input }) => ({ prompt: input.prompt, answer: null }),
  initial: "answering",
  states: {
    answering: {
      invoke: {
        id: "answer",
        src: "answerQuestion",
        input: ({ context }) => ({ prompt: context.prompt }),
        onDone: ({ output }) => ({
          target: "done",
          context: { answer: output.answer },
        }),
      },
    },
    done: {
      type: "final",
      output: ({ context }) => ({ answer: context.answer ?? "" }),
    },
  },
});
```

## Which authoring form when

<!-- canonical form vs the supported escape hatches -->

The canonical form covers most machines. Each alternate handles one specific need:

| Form                                                                                                                                        | Reach for it when                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Canonical**: `models` registry + flat schema fields on `setupAgent`, `model: 'quick'` keys, host with `createAiSdkExecutors({ models })` | Default. A single machine whose models are known at author time.                                                                                                            |
| **`createAgentSchemas` pack**: `setupAgent({ schemas })`                                                                                   | Sharing one schema set across several machines or the [step helpers](steps.md).                                                                                             |
| **String refs + `resolveModel`**: `model: 'openai/gpt-5.4-mini'`, `createAiSdkExecutors({ resolveModel })`                                 | The machine must not name concrete models: maximum portability, refs resolved by the host or loaded from JSON [config](machines-as-data.md).                               |
| **`createTextLogic`**: a standalone request value                                                                                          | A request that is exported, reused across states or machines, or unit-tested on its own. See [Text requests](text-requests.md#reusable-request-logic-with-createtextlogic). |
| **`withExecutor`**: `logic.withExecutor(...)`                                                                                              | Binding execution onto one logic rather than the whole host: per-logic host binding or an intentionally unregistered dynamic logic. Registered dynamic spawns inherit through `actors`; see [Multi-agent composition](multi-agent.md#dynamic-binding). |

## Transitions

<!-- transition-function authoring style from src/setup-agent.ts and examples/twenty-questions -->

A **transition** is a function of `{ context, event }` returning the next `target` and a `context` update (a **partial** update: omitted fields keep their values). You return updates rather than assigning them with `assign()`. The `event` is typed from the event schema.

```ts
// inside a state
on: {
  ATTACK: ({ context, event }) => ({
    target: 'summarizing',
    context: { enemyHp: Math.max(0, context.enemyHp - 6), defended: false },
  }),
}
```

> **Guards are a return value, not a `guard:` field.** Returning `undefined` from a transition function makes that transition **illegal** for the current snapshot. Because the condition and the resulting transition share one function they can never disagree, the check is visible at the transition it protects, and `snapshot.can(event)` (which powers [decision](decisions.md) legality) derives from the same code path. If you know XState's `guard:`, read "returns `undefined`" wherever you'd expect one.

```ts
// inside a state
on: {
  // ASK is only legal before the final turn.
  ASK: ({ context }) =>
    context.questionsRemaining > 1
      ? { target: 'awaitingAnswer', context: { questionsRemaining: context.questionsRemaining - 1 } }
      : undefined,
}
```

This matters for [decisions](decisions.md): a model choosing an event whose transition returns `undefined` is rejected before the transition is taken. Guards make illegal choices impossible, not just discouraged.

A transition can also be a plain object. Its `context` is a static patch or a mapper function receiving the same args (including `output` on `onDone`):

```ts
// inside a state
on: {
  SEND: { target: 'sending' },
  DEFEND: { target: 'summarizing', context: { defended: true } },
}

// on an invoke
onDone: {
  target: 'revising',
  context: ({ output }) => ({ feedback: output.feedback }),
}
```

Use the full function form when the `target` is conditional (guards) or you need `enq` to enqueue effects; use the object form otherwise.

## Invoke a request or actor

A state invokes an actor by `src` (a request key, a registered actor, or a builtin like `agent.decide` or `agent.userInput`), passing typed `input` and handling `onDone`/`onError`.

```ts
// inside states: { ... }
drafting: {
  invoke: {
    src: 'draftEmail',
    input: ({ context }) => ({ prompt: context.prompt, messages: context.messages }),
    onDone: ({ output }) => ({ target: 'reviewing', context: { draft: output } }),
    onError: { target: 'failed' },
  },
}
```

The `onDone` handler receives the actor's `output`, typed from its output schema. Both `onDone` and `onError` are transition functions too.

## Final states and output

A final state ends the machine (or a region). Its `output` is typed against the machine's output schema:

```ts
done: {
  type: 'final',
  output: ({ context }) => ({ answer: context.answer ?? '' }),
}
```

When the root declares no `output` and exactly one final state does, `createMachine` promotes that output to the root, so `snapshot.output` is set without repeating it everywhere.

> **Note:** Read `context` in a final `output` function, never the entering `event`. A final `output` function is evaluated more than once with different events, so `event` is unreliable there. Capture what you need into `context` in the transition targeting the final state, then read it back. The `lintAgentMachine` check `final-output-reads-event` flags this.

### Narrow context per state

A context field that starts `null` and is assigned mid-run forces a `?? fallback` at every later read. When a state is reachable **only** after that field is set, narrow it non-null under `setupAgent({ states })`. Declare just the fields that change; the narrowed type flows into that state's invoke `input`, transition functions, and `output`, so the coalesce disappears:

```ts
const context = z.object({ question: z.string(), plan: planSchema.nullable() });

const agentSetup = setupAgent({
  context,
  // `planning` assigns `plan` before `executing` and `done` run, so narrow it there.
  states: {
    executing: { context: { plan: planSchema } },
    done: { context: { plan: planSchema } },
  },
});
```

The field-level form is sugar for XState's full form, `executing: { schemas: { context: context.extend({ plan: planSchema }) } }`, which also works.

> **Note:** Narrow only where every path into the state has assigned the field. A state also reachable on an error or refusal route (field still `null`) must keep its nullable handling. This narrows the _type_ only; runtime behavior is unchanged.

See [examples/sql-agent/index.ts](../examples/sql-agent/index.ts).

## State and transition meta

<!-- typed meta protocol from examples/email-drafter/index.ts -->

The `meta` field attaches typed data to a state or transition. With a `meta` schema on `setupAgent`, hosts read a typed interaction protocol instead of `Record<string, unknown>`:

```ts
// inside states: { ... }
prompting: {
  meta: {
    interaction: {
      type: 'text',
      label: 'Email draft request',
      eventType: 'PROMPT_SUBMITTED',
      field: 'prompt',
    },
  },
  on: {
    PROMPT_SUBMITTED: ({ event }) => ({ target: 'evaluating', context: { prompt: event.prompt } }),
  },
}
```

A `meta` value that does not match the schema is a compile error. See [examples/email-drafter/index.ts](../examples/email-drafter/index.ts).

## Delayed transitions

A delayed transition (`after`) fires after a delay with no external event, keyed by milliseconds or by a named delay from `setupAgent`'s `delays`:

```ts
// inside states: { ... }
waiting: {
  after: { 20: { target: 'done' } },
}
```

How `after` runs depends on the host:

- Under [`runAgent`](hosts.md), the timer runs **live**: a pending `after` is not idle, so `runAgent` waits for it and continues.
- On the [step path](steps.md), it surfaces in `step.actions` as a **schedulable raise action**: the durable host owns the clock (a workflow sleep, a Temporal timer, a queue delay) and applies the event when it fires.

## Where to go next

- [Decisions](decisions.md): let the model choose exactly one currently-legal event.
- [Text requests](text-requests.md): the full request surface, streaming, and structured output.
- [Human in the loop](human-in-the-loop.md): idle states, resuming from a snapshot, and inline user input.
