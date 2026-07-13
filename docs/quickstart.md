---
title: Quickstart
description: Install @statelyai/agent and run your first agent machine end to end.
---

## Installation

<!-- install command and peer dependencies, consistent with package.json -->

```bash
npm install @statelyai/agent xstate ai @ai-sdk/openai zod
```

- `xstate` is a required peer dependency.
- `ai` (the Vercel AI SDK) is optional: only needed for the shipped adapter, `createAiSdkExecutors`. Core has no runtime dependency besides `xstate`.
- `@ai-sdk/openai` and `zod` are used in the examples below.

## Describe your models and schemas

<!-- quickstart walkthrough, based on readme.md quickstart -->

Declare a **models registry** (short keys mapped to resolved models, shared between `setupAgent` and the host) and the machine's `context`, `input`, and `output` as [Standard Schema](https://standardschema.dev) values (Zod works). These pass directly to `setupAgent` and flow through the rest of the setup.

```ts
import { z } from 'zod';
import { openai } from '@ai-sdk/openai';
import { defineModels } from '@statelyai/agent/ai-sdk';

// Model ids here are placeholders — use any model your provider offers.
const models = defineModels({ quick: openai('gpt-5.4-mini') });

const answerSchema = z.object({ answer: z.string() });
const contextSchema = z.object({ prompt: z.string(), answer: z.string().nullable() });
const inputSchema = z.object({ prompt: z.string() });
```

## Set up the agent with a request

`setupAgent` takes your models, schema fields, and requests, and returns a **setup** (not a running agent) that you author machines from, just like XState's `setup()`. A **text request** is a typed model call: it names a `model`, declares its own input and output schemas, and builds a prompt from its input.

```ts
import { setupAgent } from '@statelyai/agent';

const agentSetup = setupAgent({
  models,
  context: contextSchema,
  input: inputSchema,
  output: answerSchema,
  requests: {
    answerQuestion: {
      schemas: { input: z.object({ prompt: z.string() }), output: answerSchema },
      model: 'quick',
      prompt: ({ input }) => input.prompt,
    },
  },
});
```

The `model` value is a key into the `models` registry, so a typo is a compile error. For a machine that must not name concrete models, drop the registry and use string refs the host resolves at run time — see [Which authoring form when](machines.md#which-authoring-form-when).

## Author the machine

`agentSetup.createMachine` builds a typed XState machine. The `answering` state invokes `answerQuestion`; its `onDone` moves to `done` and writes the answer into context. `output` is already validated against the request's output schema and typed as `{ answer: string }`, so you read `output.answer` directly.

```ts
const machine = agentSetup.createMachine({
  context: ({ input }) => ({ prompt: input.prompt, answer: null }),
  initial: 'answering',
  states: {
    answering: {
      invoke: {
        id: 'answer',
        src: 'answerQuestion',
        input: ({ context }) => ({ prompt: context.prompt }),
        onDone: ({ output }) => ({
          target: 'done',
          context: { answer: output.answer },
        }),
      },
    },
    done: {
      type: 'final',
      output: ({ context }) => ({ answer: context.answer ?? '' }),
    },
  },
});
```

The machine now fully describes the agent, but nothing has called a model yet. That is the host's job.

## Run it against a host

`runAgent` drives the machine and calls the host's executors whenever a state needs a model. Build the executor set with `createAiSdkExecutors` from the `@statelyai/agent/ai-sdk` entry point, passing the same `models` registry so request keys resolve to real models.

```ts
import { runAgent } from '@statelyai/agent';
import { createAiSdkExecutors } from '@statelyai/agent/ai-sdk';

const result = await runAgent(machine, {
  input: { prompt: 'Why state machines?' },
  ...createAiSdkExecutors({ models }),
});
```

## Check the result

`runAgent` settles with a `status`:

- `done`: the machine reached a final state; `result.output` matches your output schema.
- `idle`: the machine is waiting on a human. See [Human in the loop](human-in-the-loop.md).
- `error`: something threw.

```ts
if (result.status === 'done') {
  console.log(result.output.answer);
  // logs the model's answer to "Why state machines?"
}
```

Use `runAgent` when an idle pause is expected and you handle it (human-in-the-loop, resumable flows). For a run that is meant to go straight through to a final state, `runAgentToCompletion(machine, options)` returns the output directly — it throws `AgentIdleError` if the machine pauses and rethrows the underlying error otherwise:

```ts
const output = await runAgentToCompletion(machine, { input, ...executors });
console.log(output.answer);
```

## Next steps

- [Agent machines](machines.md): authoring states, transitions, and typed context.
- [Decisions](decisions.md): let the model choose one of several legal machine events.
- [Hosts](hosts.md): model aliases, the AI SDK adapter, and writing your own executors.
