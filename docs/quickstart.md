# Quickstart

Install core:

```sh
pnpm add @statelyai/agent@alpha xstate@alpha zod
```

Add `ai` and a provider only when using the optional AI SDK adapter.

## Define and run one artifact

Save this as `agent.ts`. It uses a deterministic executor, so it needs no API
key or model SDK.

```ts
import { z } from "zod";
import { createScriptedExecutors, runAgent, setupAgent } from "@statelyai/agent";

const answerOutputSchema = z.object({ answer: z.string() });

const agent = setupAgent({
  context: z.object({ prompt: z.string(), answer: z.string().nullable() }),
  input: z.object({ prompt: z.string() }),
  output: answerOutputSchema,
  requests: {
    answer: {
      model: "fast",
      schemas: { input: z.object({ prompt: z.string() }), output: z.string() },
      prompt: ({ input }) => input.prompt,
    },
  },
});

const machine = agent.createMachine({
  context: ({ input }) => ({ prompt: input.prompt, answer: null }),
  initial: "answering",
  states: {
    answering: {
      invoke: {
        src: "answer",
        input: ({ context }) => ({ prompt: context.prompt }),
        onDone: ({ output }) => ({
          target: "done",
          context: { answer: output },
        }),
      },
    },
    done: {
      type: "final",
      output: ({ context }) => ({ answer: context.answer ?? "" }),
    },
  },
});

const scripted = createScriptedExecutors({
  text: {
    answer: ["Because transitions constrain behavior."],
  },
});

const result = await runAgent(machine, {
  input: { prompt: "Why state machines?" },
  executors: scripted,
});

if (result.status !== "done") {
  throw new Error(`Unexpected status: ${result.status}`);
}

console.log(result.output.answer);
console.log(scripted.calls[0]?.name); // "answer"
```

Run it:

```sh
npx tsx agent.ts
```

It prints:

```text
Because transitions constrain behavior.
answer
```

Requests have a semantic `name`, resolved `input`, model reference, schemas,
prompt/messages, and tools. The machine owns control flow; the executor owns
the provider call.

## Use a real model

Leave the machine unchanged and replace only the host executors:

```ts
import { openai } from "@ai-sdk/openai";
import { createAiSdkExecutors } from "@statelyai/agent/ai-sdk";

const executors = createAiSdkExecutors({
  models: { fast: openai("gpt-5.4-mini") },
});

const liveResult = await runAgent<typeof machine>(machine, {
  input: { prompt: "Why state machines?" },
  executors,
});

if (liveResult.status === "done") {
  console.log(liveResult.output);
}
```

Continue with [Choosing a run mode](choosing-a-run-mode.md),
[Messages](messages.md), and [Persistence](persistence.md).
