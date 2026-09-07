---
title: Text requests
description: Declare typed model calls on an agent machine and invoke them from a state, parsing structured or streamed output.
---

> **Alpha:** `@statelyai/agent` 2.0 is in alpha. APIs can change between releases; pin an exact version. Feedback: [github.com/statelyai/agent](https://github.com/statelyai/agent/issues).

This page covers declaring text requests, invoking them from a state, and reading structured or streamed output.

## Request declarations in setupAgent

<!-- requests config surface from src/setup-agent.ts and src/text-logic.ts -->

A **text request** is a typed model call that your machine invokes by name. You declare it once with its own input and output schemas, a model reference, and a prompt built from that input. The machine decides when the call happens. The host executes it.

Pass a `requests` map to `setupAgent`. Each entry becomes an invokable actor under the same name.

```ts
import { z } from "zod";
import { setupAgent } from "@statelyai/agent";
import { defineModels } from "@statelyai/agent/ai-sdk";
import { openai } from "@ai-sdk/openai";

// Model IDs here are illustrative; substitute your provider's current models.
const models = defineModels({
  quick: openai("gpt-5.4-mini"),
  careful: openai("gpt-5.4"),
});
const answerSchema = z.object({ answer: z.string() });

const agentSetup = setupAgent({
  models,
  context: z.object({ prompt: z.string(), answer: z.string().nullable() }),
  input: z.object({ prompt: z.string() }),
  output: answerSchema,
  requests: {
    answerQuestion: {
      schemas: { input: z.object({ prompt: z.string() }), output: answerSchema },
      model: "quick",
      system: "Answer the question directly.",
      prompt: ({ input }) => input.prompt,
    },
  },
});
```

- Each schema field accepts any [Standard Schema](https://standardschema.dev) validator.
- Both schema slots are optional. Omit `output` and the request resolves to `string`. Omit `input` and the invoke needs no `input`. A request with neither writes `schemas: {}`. The `schemas` key itself stays required on `requests` entries, while a standalone `createTextLogic` can omit it entirely.
- Each request-shaping field, such as `system`, `prompt`, `messages`, `temperature`, and `maxOutputTokens`, is either a static value or a `({ input }) => value` function.
- `prompt` and `messages` are mutually exclusive: a request must resolve exactly one of them. Resolving both, or neither, throws.

### Model references

`model` is a key into the `models` registry, or any bare string that the [host](hosts.md) resolves at run time. See [Authoring forms](machines.md#authoring-forms).

### Standalone requests

The samples later on this page use `createTextLogic`, which declares the same request as a standalone value instead of an entry in the `requests` map. The two forms take identical options. See [Reusable request logic with createTextLogic](#reusable-request-logic-with-createtextlogic).

## Invoking a request from a state

Invoke the request by name with `src`, pass `input`, and read the typed result in `onDone`. The [quickstart](quickstart.md) shows a full machine.

```ts no-check
// inside states: { ... }
answering: {
  invoke: {
    id: "answer",
    src: "answerQuestion",
    input: ({ context }) => ({ prompt: context.prompt }),
    onDone: ({ output }) => ({ target: "done", context: { answer: output.answer } }),
  },
},
```

In `onDone`, `output` is already validated against the request's output schema and typed from it. In this example the type is `{ answer: string }`, so you read `output.answer` directly. The machine needs no parsing step.

> **Note:** Route on `request.name`. Every lowered request carries its `setupAgent({ requests })` key as `name`. A mock executor, or a router that picks providers per request, tells requests apart with `request.name === 'answerQuestion'`. Do not inspect the `system` or `prompt` text. See [examples/context-compaction/index.test.ts](../examples/context-compaction/index.test.ts).

### Narrowing an unknown output outside the machine

The `parseOutput(schema, output)` helper validates a value against a schema and returns the parsed value. It throws on a mismatch. Use it in host code that holds a raw, still-untyped output, such as a value from a persisted snapshot or an inline `agent.generateText` result typed `unknown`. You never need it inside `onDone`.

```ts
import { parseOutput } from "@statelyai/agent";

const answer = parseOutput(answerSchema, rawOutput); // typed as { answer: string }
```

## Structured output vs plain text

<!-- output-mode derivation from src/text-logic.ts (getAgentOutputMode) -->

Output is structured when the schema describes an object, an array, or a top-level union of them built with `z.union` or `z.discriminatedUnion`. Otherwise the output is plain text. An `output: z.object({ ... })` schema returns a validated object. An `output: z.string()` schema returns the model's text.

> **Note for host implementers:** Every structured request is sent in a root object `{ result: <your schema> }`. The host must unwrap it before validation. This envelope keeps a bare union or array root portable, because providers that reject one at the root still accept it nested under `result`. Machine authors declare and receive the bare schema.

```ts
export const triageTicket = createTextLogic({
  schemas: {
    input: z.object({ ticket: z.string() }),
    output: z.object({
      sentiment: z.enum(["positive", "neutral", "negative"]),
      category: z.enum(["billing", "technical", "other"]),
      reply: z.string(),
    }),
  },
  model: "quick",
  system: "Triage the support ticket: sentiment, category, and a short reply.",
  prompt: ({ input }) => input.ticket,
});
```

The mode is derived from the schema automatically. You never set it. See [examples/triage/index.ts](../examples/triage/index.ts).

### Reasoning

<!-- reasoning opt-in from src/text-logic.ts (AgentTextRequest.includeReasoning) -->

Set `includeReasoning: true` on a structured request to add an optional string `reasoning` field to the envelope. The field is listed before `result`, so the property order prompts the model to reason before answering:

```ts
export const triageTicket = createTextLogic({
  schemas: { input: z.object({ ticket: z.string() }), output: triageSchema },
  model: "quick",
  includeReasoning: true, // opt in
  prompt: ({ input }) => input.ticket,
});
```

The reasoning never enters machine context or output. It surfaces in three places: on the raw executor result as `result.reasoning` from the `generateText` executor of `createAiSdkExecutors`, on `runAgent`'s `onResult(request, { raw })`, and as a `reasoning` field on the `request.end` `onTrace` event. Text-mode requests ignore the option.

`includeReasoning` is not the provider's reasoning-effort setting. Effort is the host's business, because what it means differs per provider: an enum for one, a thinking-token budget for another, nothing at all for a third. A machine that named an effort level would stop being portable. Set it where the executors are built, with [`createAiSdkExecutors({ settings })`](models-and-providers.md#host-owned-model-settings).

## Streaming requests

<!-- stream mode from src/text-logic.ts and examples/joke -->
<!-- viz: sequence diagram of a streaming request: state invokes the request -> host streamText executor -> chunks delivered to runAgent onChunk while the invoke is pending -> final text resolves onDone -->

A request streams when its `mode` is `'stream'`. Without `mode`, the request is single-shot, equivalent to `'generate'`. A streaming request resolves to the final text and delivers intermediate chunks to `runAgent`'s `onChunk`.

```ts no-check
export const tellJoke = createTextLogic({
  mode: "stream",
  schemas: { input: z.object({ topic: z.string() }), output: z.string() },
  model: "quick",
  system: "You tell short, punchy jokes.",
  prompt: ({ input }) => `Tell a joke about ${input.topic}.`,
});

const result = await runAgent(machine, {
  input: { topic: "state machines" },
  executors: { generateText, streamText },
  onChunk: (chunk) => process.stdout.write(chunk),
});
```

- `onChunk` fires once per chunk and receives the request that produced it, so parallel streams stay distinguishable.
- `onChunk` is observational only. It cannot change the run.
- A `mode: 'stream'` request needs a `streamText` executor. Without one, `runAgent` fails at bind time.

See [parallel-streams](../examples/parallel-streams/index.ts).

## Tools and multi-step loops

<!-- tools and maxSteps from src/types.ts (AgentTool), src/text-logic.ts and src/ai-sdk/index.ts -->

A text request can carry `tools`, a map of tool name to tool. The tool type is a minimal structural contract, so tools from any SDK work. See [Tools](tools.md) for the contract, how to attach tools, and how the host runs the tool loop.

To let one request run a bounded tool-call loop, set the typed `maxSteps` field on the request. The shipped AI SDK adapter forwards it as `stopWhen: stepCountIs(maxSteps)`. A request with no `maxSteps` stays single-step.

```ts no-check
export const research = createTextLogic({
  schemas: { input: z.object({ question: z.string() }), output: z.string() },
  model: "careful",
  prompt: ({ input }) => input.question,
  tools: { getWeather },
  maxSteps: 5,
});
```

> **Note:** `metadata` is host-owned per-call data. Core passes it through untouched. A host that does not understand a key ignores it, so requests stay portable across hosts.

## Reusable request logic with createTextLogic

<!-- createTextLogic from src/text-logic.ts and examples/email-drafter -->

The inline `requests` map shown above is the default form. Use `createTextLogic` when a request should be standalone, meaning exported, tested on its own, or shared across machines, and registered under `actors`. `setupAgent` builds each `requests` entry from `createTextLogic` internally, so the two forms are interchangeable. See [Authoring forms](machines.md#authoring-forms).

```ts
import { createTextLogic, setupAgent, type AgentMessage } from "@statelyai/agent";

export const draftEmail = createTextLogic({
  schemas: {
    input: z.object({
      prompt: z.string(),
      messages: z.custom<AgentMessage[]>((value) => Array.isArray(value)),
    }),
    output: z.object({ to: z.string(), subject: z.string(), body: z.string() }),
  },
  model: "careful",
  system: "Draft a polished email from the request.",
  messages: ({ input }) => [...input.messages, userMessage(input.prompt)],
});

const agentSetup = setupAgent({ models, context, input, output, actors: { draftEmail } });
```

Because `draftEmail` is a value, a test can import it and drive it with a fake executor without a machine. [examples/email-drafter/agent-logic.ts](../examples/email-drafter/agent-logic.ts) shows structured, streaming, and message-based `createTextLogic` requests across a multi-state workflow.

## Related

- Read more about [Tools](tools.md), including defining tools, attaching them to a request, and how the host runs the tool loop.
- Read more about [Hosts](hosts.md), including the executors that run text requests and how model aliases reach a provider.
- Read more about [Messages](messages.md), the `messages` field a request can send instead of a bare `prompt`.
- Read more about [Decisions](decisions.md), the other request kind, which chooses a legal machine event instead of producing text.
