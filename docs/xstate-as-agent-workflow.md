---
title: You already have an agent workflow
description: A state machine is the portable definition of an agent workflow. Bind the LLM work with whatever stack you use, run it whole or step it by hand.
---

> **Alpha:** `@statelyai/agent` 2.0 is in alpha. APIs can change between releases; pin an exact version. Feedback: [github.com/statelyai/agent](https://github.com/statelyai/agent/issues).

You already have a state machine describing your agent workflow, whether you drew it or not: states, events, transitions. This page shows how to make it real with whatever stack. The LLM work is a set of actor sources bound at run time; nothing about the shape assumes an LLM, so the same machine runs as a plain workflow, an agent, or a pure next-step function.

Two independent choices, four corners, one machine graph driving all of them:

- **Where prompts live:** embedded in the machine, or mapped in from outside.
- **How you drive it:** hand the machine to `runAgent`, or step it yourself in a `while` loop.

|                                | Prompts embedded | Prompts mapped outside     |
| ------------------------------ | ---------------- | -------------------------- |
| **Run with `runAgent`**        | Version 1        | Version 3                  |
| **Pure-function `while` loop** | Version 2        | Version 2 + `actorSources` |

## The workflow

A deliberately rough spec: **1.** write a haiku → **2.** validate (deterministic: 3 lines?) → **3.** judge (LLM: approve or revise) → **4.** revise, back to judge, **or 5.** send it.

The model only ever does two things: **produce a value** (text) or **choose an event** (a decision). Everything else (`validate`, `send`) is plain code, treated uniformly.

## Version 1: prompts embedded, run with `runAgent`

The default. Prompts live next to the states that use them.

```ts
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { createTextLogic, runAgent, setupAgent } from "@statelyai/agent";
import { createAiSdkExecutors, defineModels } from "@statelyai/agent/ai-sdk";

const models = defineModels({
  writer: openai("gpt-5.4-mini"),
  judge: openai("gpt-5.4-mini"),
});

// Text logic: "produce a value." Prompt embedded.
const writeHaiku = createTextLogic({
  schemas: { input: z.object({ topic: z.string() }), output: z.string() },
  model: "writer",
  system: "You write haiku. Three lines, 5-7-5. Output only the haiku.",
  prompt: ({ input }) => `Write a haiku about ${input.topic}.`,
});

// Same shape; revise-specific input + prompt.
const reviseHaiku = createTextLogic({
  schemas: { input: z.object({ haiku: z.string(), critique: z.string() }), output: z.string() },
  model: "writer",
  system: "You revise haiku. Output only the revised haiku.",
  prompt: ({ input }) => `Revise this haiku:\n${input.haiku}\n\nCritique:\n${input.critique}`,
});

const agentSetup = setupAgent({
  models,
  context: z.object({
    topic: z.string(),
    haiku: z.string().nullable(),
    critique: z.string().nullable(),
    revisions: z.number(),
  }),
  events: {
    // The judge chooses exactly one of these.
    APPROVE: {},
    REVISE: z.object({ critique: z.string() }),
  },
  input: z.object({ topic: z.string() }),
  output: z.object({ haiku: z.string() }),
  actorSources: { writeHaiku, reviseHaiku },
});

const haikuMachine = agentSetup.createMachine({
  id: "haiku",
  context: ({ input }) => ({ topic: input.topic, haiku: null, critique: null, revisions: 0 }),
  output: ({ context }) => ({ haiku: context.haiku ?? "" }),
  initial: "writing",
  states: {
    writing: {
      invoke: {
        src: "writeHaiku",
        input: ({ context }) => ({ topic: context.topic }),
        onDone: ({ output }) => ({ target: "validating", context: { haiku: output } }),
      },
    },
    // Deterministic, no model. `type: 'choice'` is a library pseudo-state
    // (not native XState): resolves its `choice` branch immediately, no event.
    validating: {
      type: "choice",
      choice: ({ context }) =>
        (context.haiku ?? "").trim().split("\n").filter(Boolean).length === 3
          ? { target: "judging" }
          : { target: "revising", context: { critique: "Must be exactly three lines." } },
    },
    // Decision: "choose an event." Prompt embedded in the invoke input.
    judging: {
      invoke: {
        src: "agent.decide",
        input: ({ context }) => ({
          model: "judge",
          system: "You are a poetry judge. APPROVE good haiku, else REVISE with a critique.",
          prompt: `Judge this haiku:\n${context.haiku}`,
          allowedEvents: ["APPROVE", "REVISE"],
        }),
        onError: { target: "sending" }, // out of retries -> ship it
      },
      on: {
        APPROVE: { target: "sending" },
        // Cap the loop: returning undefined makes REVISE illegal.
        REVISE: ({ context, event }) =>
          context.revisions < 3
            ? { target: "revising", context: { critique: event.critique } }
            : undefined,
      },
    },
    revising: {
      invoke: {
        src: "reviseHaiku",
        input: ({ context }) => ({ haiku: context.haiku ?? "", critique: context.critique ?? "" }),
        onDone: ({ output }) => ({
          target: "validating",
          context: { haiku: output, revisions: ({ context }) => context.revisions + 1 },
        }),
      },
    },
    sending: { type: "final" },
  },
});

const result = await runAgent(haikuMachine, {
  input: { topic: "state machines" },
  executors: createAiSdkExecutors({ models }),
});
if (result.status === "done") console.log(result.output.haiku);
```

`runAgent` walks the machine, binds each `agent.*` / text / decision source to your executors, and settles `done | idle | error`. The `REVISE` guard returning `undefined` does real work: it makes `REVISE` illegal past 3 revisions, the decision core sees that via its `canTake` check, records `rejected-by-guard`, and retries the model. The machine's guards constrain the model. That is the whole point.

## Version 2: same shape, driven as a pure function

The machine can be a **next-step decider** instead of a runner: you own the loop, the machine tells you what to do next. This is what durable hosts (Temporal, queues, Workflows) want: one model call per checkpoint, everything resumable.

```ts
// prettier-ignore
import { executeAgentRequest, initialAgentStep, resolveAgentStep, resolveDecision, transitionAgentStep } from "@statelyai/agent";

const executors = createAiSdkExecutors({ models });
let step = initialAgentStep(haikuMachine, { topic: "state machines" });

while (!step.done) {
  for (const request of step.requests) {
    if (request.kind === "text") {
      // "produce a value" -> apply the output as the invoke's done event
      const output = await executeAgentRequest(request, executors);
      step = resolveAgentStep(haikuMachine, step, request, output);
    } else {
      // "choose an event": request carries the snapshot-legal candidates;
      // resolveDecision validates + retries the choice.
      const event = await resolveDecision(request, executors.decide, {
        canTake: (e) => step.snapshot.can(e),
      });
      step = transitionAgentStep(haikuMachine, step, event);
    }
  }
}

console.log(step.snapshot.output.haiku);
```

Same machine, same executors, zero changes to the definition. `runAgent` **is** this loop with an actor and idle-detection wrapped around it. Reach for the step path when you need to persist between calls, inject a human, or run inside someone else's scheduler.

## Version 3: prompts mapped in from outside

Strip every prompt out of the machine, leaving only **structure** (state names, bare `src` strings). Prompts live in a separate map, bound at the boundary. Only the sources change; the machine graph is identical to Version 1:

```ts
import { createTextLogic } from "@statelyai/agent";

// Could live in another file, a DB row, a config service.
const prompts = {
  write: { system: "You write haiku. Three lines, 5-7-5.", prompt: ({ input }) => `Write a haiku about ${input.topic}.` },
  revise: { system: "You revise haiku.", prompt: ({ input }) => `Revise:\n${input.haiku}\n\nCritique:\n${input.critique}` },
};

// Build text actor sources from the map (your `mapStates`).
const actorSources = {
  write: createTextLogic({ model: "writer", ...prompts.write }),
  revise: createTextLogic({ model: "writer", ...prompts.revise }),
};

// runAgent merges actorSources onto the machine before the run.
const result = await runAgent(haikuMachine, {
  input: { topic: "state machines" },
  actorSources,
  executors: createAiSdkExecutors({ models }),
});
```

The `write`/`revise` invokes now name bare `src` strings; the `judge` decision stays state-local (`src: 'agent.decide'`), so its prompt lives on the invoke's `input`. `actorSources` on `runAgent` is sugar for `machine.provide({ actorSources })` (you can also `provide` them permanently, or pass them to the Version 2 step helpers unchanged). Use this form when prompts are versioned separately, edited by non-engineers, or A/B tested.

## Version 4: a plain machine, no `setupAgent`

The strongest form of the claim: the machine need not know about this library **at all**. Any machine whose invokes resolve to values, and whose events you can enumerate, is drivable.

- **`setupAgent` is optional.** It registers the five `agent.*` builtins and the schema pack. Without it, use the free functions and bind sources with `machine.provide({ actorSources: { ... } })`.
- **You don't need `agent.decide` either.** Any state that waits on events is a decision point: enumerate legal events with `getAcceptedEvents(snapshot)`, let the model choose one with `resolveDecision`, gated by `snapshot.can(event)`.

```ts
import { getAcceptedEvents, resolveDecision } from "@statelyai/agent";

// `machine` is a bog-standard xstate machine with no agent-specific anything.
const events = getAcceptedEvents(snapshot); // -> [{ type: 'APPROVE' }, { type: 'REVISE' }]

const event = await resolveDecision(
  { kind: "decision", id: "judge", model: "judge", system: "You are a poetry judge.",
    prompt: `Judge:\n${haiku}`, events, attempts: [] },
  executors.decide,
  { canTake: (e) => snapshot.can(e) },
);
```

The contract is minimal: **invokes return values, states accept events, guards decide legality.** See the runnable [plain-xstate](../examples/plain-xstate/index.ts) example.

> **Guards on event transitions:** write them as function transitions returning `undefined` when blocked (as every example here does). XState v6 drops named string guards on `on:` transitions in favor of this form, which is what makes `snapshot.can(event)` (and therefore `resolveDecision`'s `canTake`) reflect the guard. This library targets XState v6 alpha and stays compatible with v5.

A machine with **no invokes at all** (prompts written as state `description`s, `meta`, or any external lookup) runs unmodified via `runAgent`'s `getRequests` option: whenever the machine would otherwise settle idle, your hook maps the snapshot to the request(s) to run. See [described-workflow](../examples/described-workflow/index.ts).

## The portability payoff

The shape carries no LLM assumptions, so the same definition round-trips through non-code representations. `setupAgent.fromConfig` builds a machine from serializable JSON, the kind a database, visual editor, or LLM could emit:

```ts
const machine = setupAgent.fromConfig(workflowJson, { compileSchema });
await runAgent(machine, { input, executors });
```

**The machine is the portable artifact.** Prompts embedded or mapped, run whole or stepped by hand, authored in TypeScript or loaded as JSON: every combination drives the identical graph. See [Machines as data](machines-as-data.md).
