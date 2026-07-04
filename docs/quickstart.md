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

## Describe your schemas

<!-- quickstart walkthrough, based on readme.md quickstart -->

`createAgentSchemas` takes the machine's `context`, `input`, and `output` as [Standard Schema](https://standardschema.dev) values (Zod works). These types flow through the rest of the setup.

```ts
import { z } from 'zod';
import { createAgentSchemas } from '@statelyai/agent';

const answerSchema = z.object({ answer: z.string() });

const schemas = createAgentSchemas({
  context: z.object({ prompt: z.string(), answer: z.string().nullable() }),
  input: z.object({ prompt: z.string() }),
  output: answerSchema,
});
```

## Set up the agent with a request

`setupAgent` takes your schemas and requests, and returns a **setup** (not a running agent) that you author machines from, just like XState's `setup()`. A **text request** is a typed model call: it names a `model`, declares its own input and output schemas, and builds a prompt from its input.

```ts
import { setupAgent } from '@statelyai/agent';

const agentSetup = setupAgent({
  schemas,
  requests: {
    answerQuestion: {
      schemas: { input: z.object({ prompt: z.string() }), output: answerSchema },
      model: 'openai/gpt-5.4-mini',
      prompt: ({ input }) => input.prompt,
    },
  },
});
```

The `model` value is a string reference. The host resolves it to a real model later, so the machine stays free of any SDK.

## Author the machine

`agentSetup.createMachine` builds a typed XState machine. The `answering` state invokes `answerQuestion`; its `onDone` moves to `done` and writes the parsed answer into context. `parseOutput` validates the request output against its schema.

```ts
import { parseOutput } from '@statelyai/agent';

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
          context: { answer: parseOutput(answerSchema, output).answer },
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

`runAgent` drives the machine and calls the host's executors whenever a state needs a model. Build the executor set with `createAiSdkExecutors` from the `@statelyai/agent/ai-sdk` entry point.

```ts
import { runAgent } from '@statelyai/agent';
import { createAiSdkExecutors } from '@statelyai/agent/ai-sdk';
import { openai } from '@ai-sdk/openai';

const result = await runAgent(machine, {
  input: { prompt: 'Why state machines?' },
  ...createAiSdkExecutors({
    resolveModel: (modelRef) => openai(modelRef.replace(/^openai\//, '')),
  }),
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

## Next steps

- [Agent machines](machines.md): authoring states, transitions, and typed context.
- [Decisions](decisions.md): let the model choose one of several legal machine events.
- [Hosts](hosts.md): model aliases, the AI SDK adapter, and writing your own executors.
