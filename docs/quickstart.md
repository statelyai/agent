---
title: Quickstart
description: Install @statelyai/agent and run your first agent machine end to end.
---

> **Alpha:** `@statelyai/agent` 2.0 is in alpha. APIs can change between releases; pin an exact version. Feedback: [github.com/statelyai/agent](https://github.com/statelyai/agent/issues).

## Installation

<!-- pinned alpha install; peers consistent with package.json -->

```bash
npm install @statelyai/agent@alpha xstate@alpha zod ai@^6 @ai-sdk/openai@^3
```

- Pin the alpha: the API is still settling.
- `xstate` is the one required peer. The library targets **XState v6 alpha** and stays compatible with **XState v5**.
- `ai` (the Vercel AI SDK) and `@ai-sdk/openai` back the shipped adapter, `createAiSdkExecutors`. Core has no runtime dependency besides `xstate`.
- Provider packages must match your `ai` major. `@ai-sdk/openai@^3` pairs with `ai@^6`; a bare `@ai-sdk/openai` resolves to `@latest`, whose `LanguageModel` spec version may not match your `ai` peer.
- The package is **ESM-only** and the examples use top-level `await`. Set `"type": "module"` in `package.json` (or use `.mts` files).

## Describe your models and schemas

<!-- quickstart walkthrough -->

Declare a **models registry** and the machine's schemas. Model keys stay explicit in requests; the AI SDK host resolves them to provider models.

```ts
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { defineModels } from "@statelyai/agent/ai-sdk";

// Use any model your provider offers.
const models = defineModels({ quick: openai("gpt-5.4-mini") });

const answerSchema = z.object({ answer: z.string() });
```

## Set up the agent

`setupAgent` takes your models, schemas, `requests`, and `events`, and returns a **setup** (not a running agent) you author machines from, like XState's `setup()`. Three things compose in one call:

- A **text request** (`answerQuestion`) is a typed model call: it names a `model`, declares input/output schemas, and builds a prompt from its input.
- **Events** the model may choose (`ANSWER`, `PASS`).
- Machines authored from the setup can invoke `agent.decide` to let the model pick one of those events.

```ts
import { setupAgent } from "@statelyai/agent";

const agentSetup = setupAgent({
  models,
  context: z.object({ prompt: z.string(), answer: z.string().nullable() }),
  input: z.object({ prompt: z.string() }),
  output: answerSchema,
  events: {
    ANSWER: {}, // {} is shorthand for a payload-less event
    PASS: {},
  },
  requests: {
    answerQuestion: {
      schemas: { input: z.object({ prompt: z.string() }), output: answerSchema },
      model: "quick",
      prompt: ({ input }) => input.prompt,
    },
  },
});
```

The `model` value is a key into the `models` registry, so a typo is a compile error. For a machine that must not name concrete models, use string refs the host resolves at run time. See [Which authoring form when](machines.md#which-authoring-form-when).

## Author the machine

`agentSetup.createMachine` builds a typed XState machine. First the model decides whether to answer; if it chooses `ANSWER`, the `answering` state invokes `answerQuestion` and writes the validated result into context.

```ts
const machine = agentSetup.createMachine({
  context: ({ input }) => ({ prompt: input.prompt, answer: null }),
  initial: "deciding",
  states: {
    deciding: {
      invoke: {
        id: "decide",
        src: "agent.decide",
        input: ({ context }) => ({
          model: "quick",
          system: "ANSWER if you know it, else PASS.",
          prompt: context.prompt,
          allowedEvents: ["ANSWER", "PASS"],
        }),
      },
      on: {
        ANSWER: { target: "answering" },
        PASS: { target: "done" },
      },
    },
    answering: {
      invoke: {
        id: "answer",
        src: "answerQuestion",
        input: ({ context }) => ({ prompt: context.prompt }),
        onDone: ({ output }) => ({ target: "done", context: { answer: output.answer } }),
      },
    },
    done: {
      type: "final",
      output: ({ context }) => ({ answer: context.answer ?? "" }),
    },
  },
});
```

The machine now fully describes the agent, but nothing has called a model yet. That is the host's job.

## Built-in `agent.*` actor sources

`setupAgent` registers a set of built-in actor sources every machine can invoke. They are reserved `src` strings; a request's `input` shapes each call.

| `src`                  | Purpose                                                     |
| ---------------------- | ---------------------------------------------------------- |
| `agent.generateText`   | Inline one-shot text (or structured-output) model call.    |
| `agent.streamText`     | Same, streamed chunk by chunk through `onChunk`.           |
| `agent.decide`         | Model picks exactly one currently-legal event.             |
| `agent.plan`           | Model applies many legal events in a row until it stops.   |
| `agent.userInput`      | Gather human input mid-run without settling.               |

Named `requests:` (like `answerQuestion`) are the reusable, testable counterpart to inline `agent.generateText`/`agent.streamText`.

## Run it against a host

The `runAgent` function from core drives the machine, calling your **executors** whenever the machine needs a model. The `createAiSdkExecutors` helper builds that set from the AI SDK.

```ts
import { runAgent } from "@statelyai/agent";
import { createAiSdkExecutors } from "@statelyai/agent/ai-sdk";

const result = await runAgent(machine, {
  input: { prompt: "Why state machines?" },
  executors: createAiSdkExecutors({ models }),
});
```

`runAgent` settles with a `status`:

- `done`: the machine reached a final state; `result.output` matches your output schema.
- `idle`: the machine is waiting on a human. See [Human in the loop](human-in-the-loop.md).
- `error`: something threw.

```ts
if (result.status === "done") {
  console.log(result.output.answer);
}
```

Use `runAgent` when an idle pause is expected and you handle it. For a run meant to go straight through to a final state, `runAgentToCompletion(machine, options)` returns the output directly and throws `AgentIdleError` if the machine pauses.

### See it run

Watch the machine light up state by state in the [Stately Inspector](https://stately.ai/docs/inspector) while it runs. Add the inspector package and pass its handler to `runAgent`'s `inspect` option:

```bash
pnpm add @statelyai/inspect
```

```ts
import { createInspectorServer } from "@statelyai/inspect/server";
import { createWebSocketInspector } from "@statelyai/inspect";

const server = createInspectorServer({ port: 8080, url: "https://editor.stately.ai" });
const inspector = createWebSocketInspector({ url: "ws://localhost:8080" });

await runAgent(machine, {
  input: { prompt: "Why state machines?" },
  executors: createAiSdkExecutors({ models }),
  inspect: inspector.inspect, // opens the diagram and lights it up live
});
```

It's the same machine you authored, so it renders as a live diagram in the Inspector, in [Stately Studio](https://stately.ai/editor), and in the [VS Code extension](https://marketplace.visualstudio.com/items?itemName=statelyai.stately-vscode). See [Observability](observability.md) for production tracing to OpenTelemetry.

## Run it yourself (plain XState)

You do not need `runAgent` at all. `provideExecutors` binds every agent source to your executors in one call, returning a machine you drive with a plain `createActor`. No run loop, no idle settling: the machine drives itself.

```ts
import { createActor } from "xstate";
import { provideExecutors } from "@statelyai/agent";

const { generateText, streamText, decide } = createAiSdkExecutors({ models });

const actor = createActor(
  provideExecutors(machine, { generateText, streamText, decide }),
  { input: { prompt: "Why state machines?" } },
);
actor.subscribe((s) => {
  if (s.status === "done") console.log(s.output.answer);
});
actor.start();
```

The `agent.userInput` source is left unbound (supply it via `provideExecutors`'s third argument, `{ actorSources }`), and invoked child machines are not descended into. Use `runAgent` when you want idle handling and child rebinding for free.

### Mocking in a test

Executors are plain functions, so mocks are plain objects: `generateText`/`streamText` resolve `{ output }`, and `decide` resolves `{ event }` (the chosen event object). Each entry on `agentSetup.requests` is also a `TextLogic` actor you can bind individually with `.withExecutor(...)`. No network, fully deterministic:

```ts
const testMachine = provideExecutors(
  machine,
  { decide: async () => ({ event: { type: "ANSWER" } }) },
  {
    actorSources: {
      answerQuestion: agentSetup.requests.answerQuestion.withExecutor(async () => ({
        output: { answer: "Because they make illegal states unreachable." },
      })),
    },
  },
);

createActor(testMachine, { input: { prompt: "Why state machines?" } }).start();
```

The same executor mocks work with `runAgent(machine, { input, executors: { decide, generateText } })`.

## Next steps

- [Agent machines](machines.md): authoring states, transitions, and typed context.
- [Decisions](decisions.md): let the model choose one of several legal machine events.
- [Hosts](hosts.md): model aliases, the AI SDK adapter, and writing your own executors.
