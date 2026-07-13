# Any XState machine is an agent workflow

The central claim: **a state machine is the portable definition of an agent workflow.** You author the shape once (states, events, transitions). The LLM work is a set of actor sources bound at run time. Nothing about the shape assumes an LLM, so the same machine runs as a plain workflow, an agent, or a pure next-step function.

Two choices are fully independent of each other:

- **Where prompts live** — embedded in the machine, or mapped in from outside.
- **How you drive it** — hand the machine to `runAgent`, or step it yourself as a pure function in a `while` loop.

This guide writes one rough workflow four ways to show all four corners.

## The workflow

A deliberately rough spec:

1. Write a haiku
2. Validate it (deterministic: is it 3 lines?)
3. Judge it (LLM: approve or revise)
4. Revise → back to judge, **or**
5. Send it

Notice which steps are model calls (`write`, `judge`, `revise`) and which are plain code (`validate`, `send`). The machine treats them uniformly. The model only ever does two things: **produce a value** (text) or **choose an event** (a decision).

## Version 1 — prompts embedded, run with `runAgent`

The default. Prompts live next to the states that use them.

```ts
import { z } from 'zod';
import { openai } from '@ai-sdk/openai';
import {
  createTextLogic,
  runAgent,
  setupAgent,
} from '@statelyai/agent';
import { createAiSdkExecutors, defineModels } from '@statelyai/agent/ai-sdk';

const models = defineModels({
  writer: openai('gpt-5.4-mini'),
  judge: openai('gpt-5.4-mini'),
});

// Text logic: "produce a value." Prompt embedded.
const writeHaiku = createTextLogic({
  schemas: { input: z.object({ topic: z.string() }), output: z.string() },
  model: 'writer',
  system: 'You write haiku. Three lines, 5-7-5. Output only the haiku.',
  prompt: ({ input }) => `Write a haiku about ${input.topic}.`,
});

const reviseHaiku = createTextLogic({
  schemas: {
    input: z.object({ haiku: z.string(), critique: z.string() }),
    output: z.string(),
  },
  model: 'writer',
  system: 'You revise haiku. Output only the revised haiku.',
  prompt: ({ input }) =>
    `Revise this haiku:\n${input.haiku}\n\nCritique:\n${input.critique}`,
});

const agent = setupAgent({
  models,
  context: z.object({
    topic: z.string(),
    haiku: z.string().nullable(),
    critique: z.string().nullable(),
    revisions: z.number(),
  }),
  events: {
    // The judge chooses exactly one of these.
    APPROVE: z.object({}),
    REVISE: z.object({ critique: z.string() }),
  },
  input: z.object({ topic: z.string() }),
  output: z.object({ haiku: z.string() }),
  actorSources: { writeHaiku, reviseHaiku },
});

const haikuMachine = agent.createMachine({
  id: 'haiku',
  context: ({ input }) => ({
    topic: input.topic,
    haiku: null,
    critique: null,
    revisions: 0,
  }),
  output: ({ context }) => ({ haiku: context.haiku ?? '' }),
  initial: 'writing',
  states: {
    writing: {
      invoke: {
        src: 'writeHaiku',
        input: ({ context }) => ({ topic: context.topic }),
        onDone: ({ output }) => ({ target: 'validating', context: { haiku: output } }),
      },
    },

    // Deterministic. No model. A `choice` state is just a branch.
    validating: {
      type: 'choice',
      choice: ({ context }) =>
        (context.haiku ?? '').trim().split('\n').filter(Boolean).length === 3
          ? { target: 'judging' }
          : { target: 'revising', context: { critique: 'Must be exactly three lines.' } },
    },

    // Decision: "choose an event." Prompt embedded in the invoke input.
    judging: {
      invoke: {
        src: 'agent.decide',
        input: ({ context }) => ({
          model: 'judge',
          system: 'You are a poetry judge. APPROVE good haiku, else REVISE with a critique.',
          prompt: `Judge this haiku:\n${context.haiku}`,
          allowedEvents: ['APPROVE', 'REVISE'],
        }),
        onError: { target: 'sending' }, // ran out of retries -> ship it
      },
      on: {
        APPROVE: { target: 'sending' },
        // Cap the loop with a guard: return undefined = event is illegal.
        REVISE: ({ context, event }) =>
          context.revisions < 3
            ? { target: 'revising', context: { critique: event.critique } }
            : undefined,
      },
    },

    revising: {
      invoke: {
        src: 'reviseHaiku',
        input: ({ context }) => ({ haiku: context.haiku ?? '', critique: context.critique ?? '' }),
        onDone: ({ output }) => ({
          target: 'validating',
          context: { haiku: output, revisions: ({ context }) => context.revisions + 1 },
        }),
      },
    },

    sending: { type: 'final' },
  },
});

const result = await runAgent(haikuMachine, {
  input: { topic: 'state machines' },
  executors: createAiSdkExecutors({ models }),
});

if (result.status === 'done') console.log(result.output.haiku);
```

`runAgent` walks the machine, binds each `agent.*` / text / decision source to your executors, and settles `done | idle | error`. The `REVISE` guard returning `undefined` is doing real work: it makes `REVISE` illegal past 3 revisions, and the decision core (`resolveDecision`) sees that via its `canTake` check, records `rejected-by-guard`, and retries the model. The machine's guards constrain the model. That is the whole point.

## Version 2 — same shape, driven as a pure function

The machine can be a **next-step decider** instead of a runner. You own the loop; the machine only tells you what to do next. This is what durable hosts (Temporal, queues, Workflows) want: one model call per checkpoint, everything resumable.

The step helpers are free functions. Machines created by `setupAgent` carry
their registered schemas/actors, so the helpers do not need extra options in
normal use:

```ts
import {
  executeAgentRequest,
  initialAgentStep,
  resolveAgentStep,
  resolveDecision,
  transitionAgentStep,
} from '@statelyai/agent';

const executors = createAiSdkExecutors({ models });

let step = initialAgentStep(haikuMachine, { topic: 'state machines' });

while (!step.done) {
  for (const request of step.requests) {
    if (request.kind === 'text') {
      // "produce a value" -> apply the output as the invoke's done event
      const output = await executeAgentRequest(request, executors);
      step = resolveAgentStep(haikuMachine, step, request, output);
    } else {
      // "choose an event" -> the request already carries the snapshot-legal
      // candidate events; resolveDecision validates + retries the choice.
      const event = await resolveDecision(request, executors.decide, {
        canTake: (e) => step.snapshot.can(e),
      });
      step = transitionAgentStep(haikuMachine, step, event);
    }
  }
}

console.log(step.snapshot.output.haiku);
```

Same machine, same executors, zero changes to the definition. `runAgent` **is** this loop with an actor and idle-detection wrapped around it. Reach for the step path when you need to persist between calls, inject a human, or run inside someone else's scheduler; reach for `runAgent` when you just want it to go.

There is no `agent.decide()` free function. "Decide the next step" is: read the legal events off the snapshot (`getAcceptedEvents(snapshot)` or, as above, the decision request's pre-computed `events`), then `resolveDecision(...)` to pick one. The machine's `snapshot.can(event)` is the guard.

## Version 3 — prompts mapped in from outside the machine

Now strip every prompt out of the machine. The machine keeps only **structure** — state names and bare `src` strings. Prompts live in a separate map and are bound at the boundary.

> XState has no `mapStates` helper. External mapping is just a plain object keyed by actor-source name. That record *is* the map.

The machine, prompt-free:

```ts
const haikuMachine = agent.createMachine({
  id: 'haiku',
  context: ({ input }) => ({ topic: input.topic, haiku: null, critique: null, revisions: 0 }),
  output: ({ context }) => ({ haiku: context.haiku ?? '' }),
  initial: 'writing',
  states: {
    writing: {
      invoke: {
        src: 'write', // just a name
        input: ({ context }) => ({ topic: context.topic }),
        onDone: ({ output }) => ({ target: 'validating', context: { haiku: output } }),
      },
    },
    validating: { type: 'choice', choice: /* ...same as before... */ },
    judging: {
      invoke: {
        src: 'agent.decide', // state-local decision
        input: ({ context }) => ({
          model: 'judge',
          system: 'You judge haiku. APPROVE good ones, else REVISE with a critique.',
          prompt: `Judge:\n${context.haiku}`,
          allowedEvents: ['APPROVE', 'REVISE'],
        }),
        onError: { target: 'sending' },
      },
      on: { APPROVE: { target: 'sending' }, REVISE: /* ...guard as before... */ },
    },
    revising: {
      invoke: {
        src: 'revise',
        input: ({ context }) => ({ haiku: context.haiku ?? '', critique: context.critique ?? '' }),
        onDone: ({ output }) => ({ target: 'validating', context: { haiku: output, revisions: ({ context }) => context.revisions + 1 } }),
      },
    },
    sending: { type: 'final' },
  },
});
```

The prompt map, defined separately (could live in another file, a DB row, a config service):

```ts
import { createTextLogic } from '@statelyai/agent';

const prompts = {
  write: {
    system: 'You write haiku. Three lines, 5-7-5.',
    prompt: ({ input }) => `Write a haiku about ${input.topic}.`,
  },
  revise: {
    system: 'You revise haiku.',
    prompt: ({ input }) => `Revise:\n${input.haiku}\n\nCritique:\n${input.critique}`,
  },
};

// Build text actor sources from the map — this is your `mapStates`.
// The `judge` decision is state-local (`src: 'agent.decide'`), so its prompt
// lives on the invoke's `input`, not here.
const actorSources = {
  write: createTextLogic({ model: 'writer', ...prompts.write }),
  revise: createTextLogic({ model: 'writer', ...prompts.revise }),
};

// Bind at the boundary. runAgent merges actorSources onto the machine first.
const result = await runAgent(haikuMachine, {
  input: { topic: 'state machines' },
  actorSources,
  executors: createAiSdkExecutors({ models }),
});
```

Same machine graph as Version 1, but now the machine is pure control flow and the prompts are data you swap without touching it. This is the form you want when prompts are versioned separately, edited by non-engineers, or A/B tested.

`actorSources` on `runAgent` is sugar for `machine.provide({ actorSources })` before the run. You can also `provide` them permanently, or pass them into the step-path helpers — the pure-function loop from Version 2 works unchanged here.

## Version 4 — a plain XState v5-style machine, no `setupAgent`

The strongest form of the claim: the machine need not know about this library **at all**. Any machine whose invokes resolve to values, and whose events you can enumerate, is drivable.

- **`setupAgent` is optional.** It registers the four `agent.*` builtins and the schema pack. Without it, use the free functions with explicit options and bind sources with `machine.provide`.
- For a decision, you don't need `agent.decide` either. Any state that waits on events is a decision point: enumerate the legal events with `getAcceptedEvents(snapshot)`, and let the model choose one with `resolveDecision`, gated by `snapshot.can(event)`.

```ts
import { getAcceptedEvents, resolveDecision } from '@statelyai/agent';

// `machine` is a bog-standard xstate machine. Its 'judging' state has
// `on: { APPROVE: ..., REVISE: ... }` and no agent-specific anything.
const events = getAcceptedEvents(snapshot); // -> [{ type: 'APPROVE' }, { type: 'REVISE' }]

const event = await resolveDecision(
  { kind: 'decision', id: 'judge', model: 'judge', prompt: `Judge:\n${haiku}`, events, attempts: [] },
  executors.decide,
  { canTake: (e) => snapshot.can(e) },
);
```

A rough, hand-written v5 machine works because the contract is minimal: **invokes return values, states accept events, guards decide legality.** The library supplies the model; the machine supplies the shape.

## The portability payoff

Because the shape carries no LLM assumptions, the same definition round-trips through non-code representations. `setupAgent.fromConfig` builds a machine from serializable JSON — the kind a database, a visual editor, or an LLM could emit:

```ts
const machine = setupAgent.fromConfig(workflowJson, { compileSchema });
await runAgent(machine, { input, executors });
```

That closes the loop: **the machine is the portable artifact.** Prompts embedded or mapped, run whole or stepped by hand, authored in TypeScript or loaded as JSON — every combination drives the identical graph.

| | Prompts embedded | Prompts mapped outside |
|---|---|---|
| **Run with `runAgent`** | Version 1 | Version 3 |
| **Pure-function `while` loop** | Version 2 | Version 2 + `actorSources` |

## API reference

- **`setupAgent(config)`** — schema-first `setup()`. Registers `agent.generateText` / `streamText` / `decide` / `userInput` builtins; returns `createMachine` plus `schemas`, `models`, `requests`, and `appendMessages`.
- **`runAgent(machine, { input, generateText, decide, streamText?, actorSources?, userInput?, signal?, maxModelCalls?, snapshot?, event?, onTrace? })`** — runs to `done | idle | error`. Resume from `idle` by passing `{ snapshot, event }` back in.
- **`createTextLogic(config)`** — reusable "produce a value" actor source. `system`/`prompt`/`model` can each be static or `({ input }) => value`. Decisions are state-local via `src: 'agent.decide'`; to reuse one, share its input builder.
- **Step path** — `initialAgentStep` / `transitionAgentStep` / `resolveAgentStep` / `getAgentRequests`, `executeAgentRequest` (text), `resolveDecision` (decision), `getAcceptedEvents` (enumerate legal events).
- **`createAiSdkExecutors({ models })`** — returns `{ generateText, streamText, decide }` from a Vercel AI SDK model map. Spread into `runAgent` or pass to the step helpers.
