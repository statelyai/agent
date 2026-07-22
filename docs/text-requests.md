---
title: Text requests
description: Declare typed model calls on an agent machine and invoke them from a state, parsing structured or streamed output.
---

> **Alpha:** `@statelyai/agent` 2.0 is in alpha. APIs can change between releases; pin an exact version. Feedback: [github.com/statelyai/agent](https://github.com/statelyai/agent/issues).

## Declare requests in setupAgent

<!-- requests config surface from src/setup-agent.ts and src/text-logic.ts -->

A **text request** is a typed model call your machine invokes by name: declared once with its own input/output schemas, a model reference, and a prompt built from that input. The machine decides when to call; the host executes it. Pass a `requests` map to `setupAgent`; each entry becomes an invokable actor under the same name.

```ts
import { z } from "zod";
import { setupAgent } from "@statelyai/agent";
import { defineModels } from "@statelyai/agent/ai-sdk";
import { openai } from "@ai-sdk/openai";

const models = defineModels({ quick: openai("gpt-5.4-mini") });
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
- Each request-shaping field (`system`, `prompt`, `messages`, `temperature`, `maxOutputTokens`, and the rest) is a static value or a `({ input }) => value` function.

### Model references

Prefer a `models` registry (canonical): it narrows `model` to the map's keys (`model: "quick"` is typed as `"quick" | "careful"`), so a typo is a compile error and one alias map is shared between authoring and the host adapter. A bare `model` string (any string, passed through to your [host](hosts.md) to resolve) is the alternative for a machine that must not name concrete models. See [Which authoring form when](machines.md#which-authoring-form-when).

## Invoke a request from a state

Invoke by name with `src`, pass `input`, read the typed result in `onDone` (full machine in the [quickstart](quickstart.md)):

```ts
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

In `onDone`, `output` is already validated against the request's output schema and typed from it (`{ answer: string }` here) - read `output.answer` directly, no parsing step in the machine.

> **Note: route on `request.name`.** Every lowered request carries its `setupAgent({ requests })` key as `name`, so a mock executor (or a router picking providers per request) tells requests apart with `request.name === 'answerQuestion'`. Do not sniff `system`/`prompt` text. See [examples/context-compaction/index.test.ts](../examples/context-compaction/index.test.ts).

### Narrowing an unknown output outside the machine

The `parseOutput(schema, output)` helper validates a value against a schema and returns it parsed, throwing on mismatch. Use it in host code holding a raw, still-untyped output (from a persisted snapshot, or an inline `agent.generateText` result typed `unknown`). Never needed inside `onDone`.

```ts
import { parseOutput } from "@statelyai/agent/adapter";

const answer = parseOutput(answerSchema, rawOutput); // typed as { answer: string }
```

## Structured output vs plain text

<!-- output-mode derivation from src/text-logic.ts (getAgentOutputMode) -->

Output is **structured** when the schema describes an object, an array, or a top-level union of them (`z.union`/`z.discriminatedUnion`), and plain text otherwise: `output: z.object({ ... })` returns a validated object, `output: z.string()` returns the model's text.

Every structured request is sent wrapped in the [structured-output envelope](./hosts.md#the-structured-output-envelope): a root object `{ result: <your schema> }` that hosts unwrap before validation. This makes a bare union or array root portable (nested under `result`, so providers that reject a union/array _root_ still accept it). You always declare and receive the bare schema; the envelope is invisible to the machine.

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
  model: "ticketTriage",
  system: "Triage the support ticket: sentiment, category, and a short reply.",
  prompt: ({ input }) => input.ticket,
});
```

The mode is derived from the schema automatically; you never set it. See [examples/triage/index.ts](../examples/triage/index.ts).

### Reasoning

<!-- reasoning opt-in from src/text-logic.ts (AgentTextRequest.reasoning) -->

Set `reasoning: true` on a structured request to add an optional string `reasoning` field to the [envelope](./hosts.md#the-structured-output-envelope), listed **before** `result` so property order nudges the model to reason before answering:

```ts
export const triageTicket = createTextLogic({
  schemas: { input: z.object({ ticket: z.string() }), output: triageSchema },
  model: "ticketTriage",
  reasoning: true, // opt in
  prompt: ({ input }) => input.ticket,
});
```

The reasoning never enters machine context or output; it surfaces only on the raw executor result (`result.reasoning` on `createAiSdkExecutors`' `generateText`), on `runAgent`'s `onResult(request, { raw })`, and as a `reasoning` field on the `request.end` `onTrace` event. Ignored for text-mode requests.

## Streaming requests

<!-- stream mode from src/text-logic.ts and examples/joke -->

A request streams when its `mode` is `'stream'`; without `mode` it is single-shot (`'generate'`). A streaming request resolves to the final text, with intermediate chunks delivered to `runAgent`'s `onChunk`.

```ts
export const tellJoke = createTextLogic({
  mode: "stream",
  schemas: { input: z.object({ topic: z.string() }), output: z.string() },
  model: "jokeWriter",
  system: "You tell short, punchy jokes.",
  prompt: ({ input }) => `Tell a joke about ${input.topic}.`,
});

const result = await runAgent(machine, {
  input: { topic: "state machines" },
  executors: { generateText, streamText },
  onChunk: (chunk) => process.stdout.write(chunk),
});
```

The `onChunk` callback fires per chunk alongside the request that produced it, so parallel streams stay distinguishable. It is purely observational. A `mode: 'stream'` request needs a `streamText` executor; without one, `runAgent` fails at bind time. See [examples/joke/index.ts](../examples/joke/index.ts).

## Tools and multi-step loops

<!-- tools and metadata.maxSteps from src/types.ts (AgentTool) and src/ai-sdk/index.ts -->

A text request can carry `tools`: a map of tool name to a tool. **Tools are whatever your SDK produces** - the type is a minimal structural contract (`description?`, `inputSchema?`, `outputSchema?`, `execute?`, plus any extra fields), so an AI SDK `tool({...})`, an MCP-style descriptor, or a plain object all drop in as-is. Extra fields (`providerOptions`, `toModelOutput`, …) pass through untouched.

Bring your SDK's tool and it owns the input typing, so `execute`'s argument is typed with no cast:

```ts
import { tool } from 'ai';

// inside a request
tools: {
  getWeather: tool({
    description: 'Look up the current weather for a city.',
    inputSchema: z.object({ city: z.string() }),
    execute: async ({ city }) => fetchWeather(city), // city: string
  }),
}
```

For a host with no SDK, the minimal shape is a plain object (or a bare `execute` function). Core reads `description`/`inputSchema` and runs `execute`:

```ts
// inside a request
tools: {
  getWeather: {
    description: 'Look up the current weather for a city.',
    inputSchema: z.object({ city: z.string() }),
    execute: async (input) => fetchWeather((input as { city: string }).city),
  },
}
```

To let one request run a bounded tool-call loop, set `metadata.maxSteps`. The shipped AI SDK adapter forwards it as `stopWhen: stepCountIs(maxSteps)`; a request with no `maxSteps` stays single-step.

```ts
export const research = createTextLogic({
  schemas: { input: z.object({ question: z.string() }), output: z.string() },
  model: "careful",
  prompt: ({ input }) => input.question,
  tools: { getWeather },
  metadata: { maxSteps: 5 },
});
```

> **Note:** `metadata` is host-owned per-call data, passed through untouched by core. A host that does not understand a key ignores it, so requests stay portable across hosts.

## Reusable request logic with createTextLogic

<!-- createTextLogic from src/text-logic.ts and examples/email-drafter -->

Inline `requests:` (above) is the default. Reach for `createTextLogic` when a request should be standalone (exported, tested on its own, or shared across machines) and registered under `actorSources`. Each `requests` entry is exactly what `setupAgent` builds internally from `createTextLogic`, so the two are interchangeable. See [Which authoring form when](machines.md#which-authoring-form-when).

```ts
import { createTextLogic, setupAgent } from "@statelyai/agent";

export const draftEmail = createTextLogic({
  schemas: {
    input: z.object({ prompt: z.string(), messages: messagesSchema }),
    output: z.object({ to: z.string(), subject: z.string(), body: z.string() }),
  },
  model: "emailDrafter",
  system: "Draft a polished email from the request.",
  messages: ({ input }) => [...input.messages, userMessage(input.prompt)],
});

const agentSetup = setupAgent({ models, context, input, output, actorSources: { draftEmail } });
```

Because `draftEmail` is a value, a test can import it and drive it with a fake executor, no machine required. [examples/email-drafter/index.ts](../examples/email-drafter/index.ts) shows structured, streaming, and message-based `createTextLogic` requests across a multi-state workflow.

## Related

- [Hosts](hosts.md): the executors that run text requests and how model aliases reach a provider.
- [Messages](messages.md): the `messages` field a request can send instead of a bare `prompt`.
- [Decisions](decisions.md): the other request kind, choosing a legal machine event instead of producing text.
