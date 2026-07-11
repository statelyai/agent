---
title: Text requests
description: Declare typed model calls on an agent machine and invoke them from a state, parsing structured or streamed output.
---

## Overview

A **text request** is a typed model call your machine can invoke by name. You declare it once, with its own input and output schemas, a model reference, and a prompt built from that input. The machine decides when to make the call; the host executes it.

## Declare requests in setupAgent

<!-- requests config surface from src/setup-agent.ts and src/text-logic.ts -->

Pass a `requests` map to `setupAgent`. Each entry becomes an invokable actor under the same name.

```ts
import { z } from 'zod';
import { setupAgent } from '@statelyai/agent';
import { openai } from '@ai-sdk/openai';

const models = { quick: openai('gpt-5.4-mini') } as const;
const answerSchema = z.object({ answer: z.string() });

const agentSetup = setupAgent({
  models,
  context: z.object({ prompt: z.string(), answer: z.string().nullable() }),
  input: z.object({ prompt: z.string() }),
  output: answerSchema,
  requests: {
    answerQuestion: {
      schemas: { input: z.object({ prompt: z.string() }), output: answerSchema },
      model: 'quick',
      system: 'Answer the question directly.',
      prompt: ({ input }) => input.prompt,
    },
  },
});
```

- Each schema field accepts any [Standard Schema](https://standardschema.dev) validator.
- Each request-shaping field (`system`, `prompt`, `messages`, `temperature`, `maxOutputTokens`, and the rest) is either a static value or a `({ input }) => value` function.

### Model references and typed aliases

Prefer a `models` registry (the canonical form): it narrows `model` to the map's keys, making a typo a compile error and sharing one alias map between authoring and the host adapter. A bare `model` string is the escape hatch — any string, passed straight through to your [host](hosts.md) to resolve — for a machine that must not name concrete models (see [Which authoring form when](machines.md#which-authoring-form-when)).

```ts
import { openai } from '@ai-sdk/openai';

const models = {
  quick: openai('gpt-5.4-mini'),
  careful: openai('gpt-5.4'),
} as const;

const agentSetup = setupAgent({
  models,
  context: z.object({ prompt: z.string(), answer: z.string().nullable() }),
  input: z.object({ prompt: z.string() }),
  output: answerSchema,
  requests: {
    answerQuestion: {
      schemas: { input: z.object({ prompt: z.string() }), output: answerSchema },
      model: 'quick', // typed as "quick" | "careful"
      prompt: ({ input }) => input.prompt,
    },
  },
});
```

## Invoke a request from a state

Invoke by name with `src`, pass `input`, read the typed result in `onDone`:

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

Inside `onDone`, `output` is already validated against the request's own output schema and typed from it (`{ answer: string }` here), so you read `output.answer` directly — no parsing step is ever needed in the machine.

### Narrowing an unknown output outside the machine

`parseOutput(schema, output)` validates a value against a schema and returns it parsed, throwing on mismatch. It is an escape hatch for host code that holds a raw, still-untyped output — e.g. a value read back from a persisted snapshot, or an inline `agent.generateText` result whose static type is `unknown`. Inside a request's `onDone` it is never needed.

```ts
import { parseOutput } from '@statelyai/agent';

// Host code with an untyped value from elsewhere:
const answer = parseOutput(answerSchema, rawOutput); // typed as { answer: string }
```

## Structured output vs plain text

<!-- output-mode derivation from src/text-logic.ts (getAgentOutputMode) -->

Output is **structured** when the output schema describes an object, an array, or a top-level union of them (`z.union`/`z.discriminatedUnion`), and plain text otherwise: `output: z.object({ ... })` returns a validated object, `output: z.string()` returns the model's text.

> **Provider caveat:** some providers reject certain top-level union encodings in structured-output mode (OpenAI rejects the `oneOf` that `z.discriminatedUnion` emits, while accepting `z.union`'s `anyOf`). The portable pattern is wrapping the union in an object field: `output: z.object({ action: z.union([...]) })`. See [examples/react-agent](../examples/react-agent).

```ts
export const triageTicket = createTextLogic({
  schemas: {
    input: z.object({ ticket: z.string() }),
    output: z.object({
      sentiment: z.enum(['positive', 'neutral', 'negative']),
      category: z.enum(['billing', 'technical', 'other']),
      reply: z.string(),
    }),
  },
  model: 'ticketTriage',
  system: 'Triage the support ticket: sentiment, category, and a short reply.',
  prompt: ({ input }) => input.ticket,
});
```

The mode is derived from the schema for you. Host adapters read it (via the exported `getAgentOutputMode`/`isStructuredOutputSchema`) to decide whether to request structured output from the provider; you rarely call these directly. See [examples/triage/index.ts](../examples/triage/index.ts).

## Streaming requests

<!-- stream mode from src/text-logic.ts and examples/joke -->

A request streams when its `mode` is `'stream'`; without `mode` it is single-shot (`'generate'`). A streaming request resolves to the final text, with intermediate chunks delivered to `runAgent`'s `onChunk`.

```ts
export const tellJoke = createTextLogic({
  mode: 'stream',
  schemas: {
    input: z.object({ topic: z.string() }),
    output: z.string(),
  },
  model: 'jokeWriter',
  system: 'You tell short, punchy jokes.',
  prompt: ({ input }) => `Tell a joke about ${input.topic}.`,
});
```

```ts
const result = await runAgent(machine, {
  input: { topic: 'state machines' },
  generateText,
  streamText,
  onChunk: (chunk) => process.stdout.write(chunk),
});
```

`onChunk` fires per chunk alongside the request that produced it, so parallel streams stay distinguishable. It is purely observational. A `mode: 'stream'` request needs a `streamText` executor; without one, `runAgent` fails at bind time. See [examples/joke/index.ts](../examples/joke/index.ts).

## Tools and multi-step loops

<!-- tools and metadata.maxSteps from src/types.ts (AgentTool) and src/ai-sdk/index.ts -->

A text request can carry `tools`: a map of tool name to a full descriptor (`description`, `inputSchema`, `outputSchema`, `execute`) or a bare `execute` function.

```ts
tools: {
  getWeather: {
    description: 'Look up the current weather for a city.',
    inputSchema: z.object({ city: z.string() }),
    execute: async ({ city }) => fetchWeather(city),
  },
}
```

To let one request run a bounded tool-call loop, set `metadata.maxSteps`. The shipped AI SDK adapter forwards it as `stopWhen: stepCountIs(maxSteps)`; a request with no `maxSteps` stays single-step.

```ts
export const research = createTextLogic({
  schemas: { input: z.object({ question: z.string() }), output: z.string() },
  model: 'careful',
  prompt: ({ input }) => input.question,
  tools: { getWeather },
  metadata: { maxSteps: 5 },
});
```

> **Note:** `metadata` is host-owned per-call data, passed through untouched by core. A host that does not understand a key ignores it, so requests stay portable across hosts.

## Reusable request logic with createTextLogic

<!-- createTextLogic from src/text-logic.ts and examples/email-drafter -->

Inline `requests:` (above) is the default. `createTextLogic` is the escape hatch when a request should be standalone — exported, tested on its own, or shared across machines — and registered under `actorSources`. A `requests` entry is exactly what `setupAgent` builds internally from `createTextLogic`, so the two are interchangeable (see [Which authoring form when](machines.md#which-authoring-form-when)).

```ts
import { createTextLogic, setupAgent } from '@statelyai/agent';

export const draftEmail = createTextLogic({
  schemas: {
    input: z.object({ prompt: z.string(), messages: messagesSchema }),
    output: z.object({ to: z.string(), subject: z.string(), body: z.string() }),
  },
  model: 'emailDrafter',
  system: 'Draft a polished email from the request.',
  messages: ({ input }) => [...input.messages, userMessage(input.prompt)],
});

const agentSetup = setupAgent({
  models,
  context,
  input,
  output,
  actorSources: { draftEmail },
});
```

Because `draftEmail` is a value, a test can import it and drive it with a fake executor, no machine required. [examples/email-drafter/index.ts](../examples/email-drafter/index.ts) shows structured, streaming, and message-based `createTextLogic` requests across a multi-state workflow.

## Related

- [Hosts](hosts.md): the executors that run text requests and how model aliases reach a provider.
- [Messages](messages.md): the `messages` field a request can send instead of a bare `prompt`.
- [Decisions](decisions.md): the other request kind, choosing a legal machine event instead of producing text.
