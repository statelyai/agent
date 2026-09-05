---
title: Agent machines
description: Author an agent machine as a typed XState state machine that decides what your agent can do, while the host executes model calls.
---

> **Alpha:** `@statelyai/agent` 2.0 is in alpha. APIs can change between releases; pin an exact version. Feedback: [github.com/statelyai/agent](https://github.com/statelyai/agent/issues).

## Overview

An **agent machine** is a typed XState state machine that describes what your agent can do. It declares the states, the legal transitions, the model calls, and the events the model may choose in each state. An agent machine never calls a model itself. The host executes model calls on its behalf.

<!-- viz: data-flow figure of the machine/host boundary: machine invokes a request -> host executor calls the model SDK -> output validated against the output schema -> onDone transition applied to the machine -->

Author a machine in three steps:

1. Declare a models registry and your `context`/`input`/`output`/`events` schema fields.
2. Pass them to `setupAgent` with your requests and actor sources.
3. Build with `agentSetup.createMachine`.

## Schema declarations

<!-- flat schema fields on setupAgent from src/setup-agent.ts -->

Pass schema fields directly to `setupAgent` to type your data. `context` is required. `input`, `output`, `events`, `emitted`, and `meta` are optional.

Every schema is a [Standard Schema](https://standardschema.dev). Zod, Valibot, ArkType, and hand-written validators all work. The agent retains the schemas, so context and events are typed without `{} as Type` casts.

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

<!-- machine input validation from src/run-agent.ts and the input schema retained by src/setup-agent.ts -->

`runAgent` validates supplied machine input before the
actor starts. Defaults and transforms from the input schema reach the context
factory and trace; invalid input throws `AgentError` with code
`invalid-machine-input`. Calling XState's `createActor` directly does not run
this validation.

To keep conversation history in context, add a `messages` field with the `z.custom<AgentMessage[]>` recipe. See [Messages](messages.md).

### Event schemas

Event schemas type event payloads. Declare one schema per event type under `events`:

```ts no-check
// setupAgent({ ... })
events: {
  ATTACK: z.object({ target: z.string().default('goblin') }),
  HEAL: z.object({ amount: z.number().min(1).max(8).default(4) }),
  FLEE: {},
},
// ...
```

In a `HEAL` transition, `event.amount` is a `number`. Reading a field the event does not carry is a compile error. Write `{}` for a payload-less event.

### Emitted event schemas

Emitted event schemas type the progress events a machine emits with `enq.emit(...)`. Hosts receive them through `runAgent`'s `on` handlers. Declare them under `emitted`:

```ts no-check
// setupAgent({ ... })
emitted: {
  EVALUATED: z.object({ qualityScore: z.number(), iteration: z.number() }),
},
// ...
```

Both `enq.emit({ type: 'EVALUATED', ... })` and the host-side `on: { EVALUATED: handler }` are then typed. An undeclared type or a wrong payload is a compile error. See [Observability](observability.md).

> **Note:** To reuse one schema set across machines or the step helpers, declare it once with `createAgentSchemas({ context, input, output, events })` and pass it as `setupAgent({ schemas })`. This is equivalent to the inline form. See [Authoring forms](#authoring-forms).

<!-- getAgentSchemas registration and lookup from src/setup-agent.ts -->

When a generic host receives only a machine, call `getAgentSchemas(machine)` to
recover its schema pack for validation or form generation. It returns
`undefined` for plain XState machines. Read it before `machine.provide(...)`;
the provided machine is a new object and does not carry the registration.

### Type extraction

<!-- public type helpers from src/type-helpers.ts and src/index.ts -->

Use the exported `ContextOf`, `InputOf`, `OutputOf`, and `EventOf` helpers with
either an Agent setup or a machine. Machine-only helpers are `SnapshotOf` and
`StateValueOf`; `MetaOf` extracts declared metadata, and `RequestNamesOf`
extracts a setup's registered request-name union.

```ts
import type { ContextOf, EventOf, RequestNamesOf, SnapshotOf } from "@statelyai/agent";

type AgentContext = ContextOf<typeof agentSetup>;
type AgentEvent = EventOf<typeof machine>;
type AgentSnapshot = SnapshotOf<typeof machine>;
type RequestName = RequestNamesOf<typeof agentSetup>;
```

## Agent setup

<!-- setupAgent config surface (models, requests, actors, builtins) from src/setup-agent.ts -->

Beyond schemas, `setupAgent` takes your models plus optional `requests`, `actors`, `actions`, `guards`, `states`, and `delays`. `states` narrows context per state. See [Per-state context narrowing](#per-state-context-narrowing). `delays` names the durations that [delayed transitions](#delayed-transitions) reference. It returns a **setup** whose `createMachine` method builds the machine. Like XState's `setup()`, the return value is a typed foundation, not a running agent. Name it accordingly, for example `agentSetup` or `gameSetup`.

The builtins `agent.generateText`, `agent.streamText`, `agent.decide`, and `agent.userInput` are registered automatically. Invoke them by name.

### Models

The `models` map pairs a short alias with a resolved model. Request and decision `model:` values autocomplete against its keys. Pass the same map to the host adapter. See [Models and providers](models-and-providers.md).

```ts
import { openai } from "@ai-sdk/openai";
import { defineModels } from "@statelyai/agent/ai-sdk";

const models = defineModels({
  quick: openai("gpt-5.4-mini"),
  careful: openai("gpt-5.4"),
});

const agentSetup = setupAgent({
  models,
  context,
  input,
  output,
  requests: {
    answerQuestion: {
      schemas: { input: z.object({ prompt: z.string() }), output: answerSchema },
      model: "quick", // typed as "quick" | "careful"
      prompt: ({ input }) => input.prompt,
    },
  },
});
```

Aliases are optional. A request can carry any `model:` string, such as `'openai/gpt-5.4-mini'`, that the host resolves at run time. See [Authoring forms](#authoring-forms).

### Requests

The `requests` map declares named text requests inline. Each entry carries its own input and output schemas, a model, and a `prompt` or `messages` value built from typed input. Each entry becomes an actor you invoke by its key.

```ts no-check
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

The `actors` map registers reusable actor logic. This can be text logic from `createTextLogic` or any XState actor. Register logic here when it is reusable, exported, or worth testing on its own.

Decisions are state-local. They use `src: 'agent.decide'` and are not actor sources. To reuse a decision, share its input builder.

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

> **Warning:** Actor source keys must be unique across `actors` and `requests`. `setupAgent` throws at setup time on a collision.

### Built-in actor sources

<!-- builtin src reference, from src/setup-agent.ts -->

`setupAgent` registers reserved `src` strings on every machine. Use them for ad-hoc model work that does not warrant a named request. The invoke's `input` shapes each call:

| `src`                | Invoke `input`                                                              | `onDone` output                                        | Reference                                 |
| -------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------ | ----------------------------------------- |
| `agent.generateText` | `model`, `prompt` or `messages`, optional `system`, `outputSchema`, `tools` | text, or the value parsed from `outputSchema`          | [Text requests](text-requests.md)         |
| `agent.streamText`   | same as `agent.generateText`                                                | same, with chunks delivered to the host as they arrive | [Text requests](text-requests.md)         |
| `agent.decide`       | `model`, `prompt`, optional `system`, `allowedEvents`                       | the one chosen event, applied to the machine           | [Decisions](decisions.md)                 |
| `agent.userInput`    | `prompt`, optional `schema`                                                 | the human's value                                      | [Human in the loop](human-in-the-loop.md) |

Named `requests` are the default form because they are typed, reusable, and testable. The builtins are the inline alternative. The host executes both, so neither form names a model SDK in the machine.

## Authoring forms

<!-- canonical form vs the supported escape hatches -->

The canonical form covers most machines: a `models` registry, flat schema fields on `setupAgent`, `model: 'quick'` alias keys, and a host with `createAiSdkExecutors({ models })`. Use it whenever the models are known at author time.

Each alternate form handles one specific need:

| Form                                                                                                             | Use it when                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createAgentSchemas` pack, passed as `setupAgent({ schemas })`                                                   | You share one schema set across several machines or the [step helpers](steps.md).                                                                                                                                                                 |
| String model refs with `resolveModel` (`model: 'openai/gpt-5.4-mini'`, `createAiSdkExecutors({ resolveModel })`) | The machine must not name concrete models, for portability or for refs loaded from JSON [config](machines-as-data.md).                                                                                                                            |
| `createTextLogic`, a standalone request value                                                                    | A request is exported, reused across states or machines, or unit-tested on its own. See [Text requests](text-requests.md#reusable-request-logic-with-createtextlogic).                                                                            |
| `logic.withExecutor(...)`                                                                                        | You bind execution onto one logic instead of the whole host, so a plain `createActor` runs it without [`runAgent`](hosts.md)'s executor slots. Registered dynamic spawns inherit through `actors`. See [Multi-agent composition](multi-agent.md). |

## Machine creation

`agentSetup.createMachine` is XState's `createMachine` with the agent's schemas and actors already bound. It registers the machine, so the step helpers and [`runAgent`](hosts.md) resolve its schemas and actors without you passing them again.

<!-- viz: state diagram for the answering machine below: initial state `answering` invoking the `answerQuestion` request, onDone -> final state `done` producing { answer } -->

```ts no-check
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

## Per-state context narrowing

A context field that starts `null` and is assigned mid-run forces a `?? fallback` at every later read. When a state is reachable only after that field is set, narrow it with XState's native per-state context schema under `setupAgent({ states })`. The narrowed type flows into that state's invoke `input`, transition functions, and `output`, so the fallback is no longer needed:

```ts
const context = z.object({ question: z.string(), plan: planSchema.nullable() });

const agentSetup = setupAgent({
  context,
  // `planning` assigns `plan` before `executing` and `done` run, so narrow it there.
  states: {
    executing: { schemas: { context: context.extend({ plan: planSchema }) } },
    done: { schemas: { context: context.extend({ plan: planSchema }) } },
  },
});
```

> **Note:** Narrow only where every path into the state has assigned the field. A state that is also reachable on an error or refusal route, where the field is still `null`, must keep its nullable handling. Narrowing changes the type only. Runtime behavior is unchanged.

See [examples/sql-agent/index.ts](../examples/sql-agent/index.ts).

## Transitions

<!-- transition-function authoring style from src/setup-agent.ts and examples/twenty-questions -->

A **transition** is a function of `{ context, event }` that returns the next `target` and a `context` update. The update is partial: omitted fields keep their values. You return updates instead of assigning them with `assign()`. The `event` is typed from the event schema.

```ts no-check
// inside a state
on: {
  ATTACK: ({ context, event }) => ({
    target: 'summarizing',
    context: { enemyHp: Math.max(0, context.enemyHp - 6), defended: false },
  }),
}
```

> **Note:** Guards are a return value, not a `guard:` field. Returning `undefined` from a transition function makes that transition illegal for the current snapshot. The condition and the transition live in the same function, so they cannot disagree. `snapshot.can(event)`, which determines [decision](decisions.md) legality, derives from the same code path. If you know XState's `guard:`, read "returns `undefined`" wherever you would expect one.

```ts no-check
// inside a state
on: {
  // ASK is only legal before the final turn.
  ASK: ({ context }) =>
    context.questionsRemaining > 1
      ? { target: 'awaitingAnswer', context: { questionsRemaining: context.questionsRemaining - 1 } }
      : undefined,
}
```

This affects [decisions](decisions.md). If the model chooses an event whose transition returns `undefined`, the choice is rejected before the transition is taken.

A transition can also be a plain object. Its `context` is a static patch, or a mapper function that receives the same arguments. On `onDone`, those arguments include `output`:

```ts no-check
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

Use the function form when the `target` is conditional or when you need `enq` to enqueue effects. Use the object form otherwise.

## Choice states

<!-- choice state node type from xstate v6 (StateMachine formatChoiceTransitions) and src/machines/loop.ts -->

A **choice state** routes to one of several targets without waiting for an event. Set `type: 'choice'` and give the state a `choice` function of `{ context, event }` that returns the transition to take. The machine enters the state, runs the function, and leaves immediately.

```ts no-check
// inside states: { ... }
checking: {
  type: 'choice',
  choice: ({ context }) =>
    context.iterations >= context.maxTurns || context.done
      ? { target: 'done' }
      : { target: 'running' },
},
```

The returned object takes the same fields as a transition object, including `context` for a partial context update. The function must return a target. A choice state whose function returns no target throws at run time.

A choice state has no other behavior. `on`, `always`, `after`, `entry`, `exit`, `invoke`, and `states` are not allowed on it. Put the work in the target states.

Use a choice state when the branch is a pure routing decision the machine makes on its own, such as a loop bound or a score threshold. Use a [decision](decisions.md) when the model picks the branch.

In a JSON [machine config](machines-as-data.md), `choice` is an array of branches instead of a function. Each branch carries an optional `guard` and a `target`, and the first branch whose guard passes wins. A branch with no guard is the fallback.

## Request and actor invokes

A state invokes an actor by `src`. The `src` is a request key, a registered actor, or a builtin such as `agent.decide` or `agent.userInput`. The state passes typed `input` and handles `onDone` and `onError`.

```ts no-check
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

The `onDone` handler receives the actor's `output`, typed from its output schema. Both `onDone` and `onError` are transition functions.

### Inline text requests

<!-- inline agent.generateText + runAgent, from src/setup-agent.ts and src/index.ts -->

For a one-off text call, invoke `agent.generateText` inline. Move it to a named [request](text-requests.md) once it is reused or worth testing:

```ts no-check
import { parseOutput, runAgent } from "@statelyai/agent";

// ...
generating: {
  invoke: {
    id: "draft",
    src: "agent.generateText",
    input: ({ context }) => ({
      model: "openai/gpt-5.4-mini",
      prompt: context.prompt,
      outputSchema: resultSchema,
    }),
    onDone: ({ output }) => ({
      target: "done",
      context: { result: parseOutput(resultSchema, output) },
    }),
  },
},

// ...
await runAgent(machine, { input, executors: { generateText, streamText } });
```

Give an invoke an explicit `id` when the host needs a stable occurrence identity. XState owns invoke identity and snapshot restoration.

## Final states and output

A final state ends the machine or a region of it. Its `output` is typed against the machine's output schema:

```ts no-check
done: {
  type: 'final',
  output: ({ context }) => ({ answer: context.answer ?? '' }),
}
```

When the root declares no `output` and exactly one final state does, `createMachine` promotes that final state's output to the root. `snapshot.output` is then set without you declaring the output twice.

> **Note:** Read durable domain data from `context` in a final `output` function. Capture entering-event data into context when the transition needs it later.

## State and transition meta

<!-- typed meta protocol from examples/email-drafter/agent-logic.ts -->

The `meta` field attaches typed data to a state or transition. When you declare a `meta` schema on `setupAgent`, hosts read a typed interaction protocol instead of `Record<string, unknown>`:

```ts no-check
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

A `meta` value that does not match the schema is a compile error. See [examples/email-drafter/agent-logic.ts](../examples/email-drafter/agent-logic.ts).

## Delayed transitions

A delayed transition (`after`) fires after a delay, with no external event. Key it by milliseconds or by a named delay from `setupAgent`'s `delays`:

```ts no-check
// inside states: { ... }
waiting: {
  after: { 20: { target: 'done' } },
}
```

How `after` runs depends on the host:

- Under [`runAgent`](hosts.md), the timer runs live. A pending `after` does not count as idle, so `runAgent` waits for it and continues.
- Under a custom or durable XState host, timers follow that framework's runtime adapter. See [the XState transition loop](steps.md).

## Related

- Read more about [Decisions](decisions.md), where the model chooses one currently-legal event.
- Read more about [Text requests](text-requests.md), including streaming and structured output.
- Read more about [Human in the loop](human-in-the-loop.md), including idle states, resuming from a snapshot, and inline user input.
