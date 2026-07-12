---
title: Hosts and executors
description: Give an agent machine the executor functions that call a model, and choose between the shipped AI SDK adapter or your own.
---

## The executor contract

<!-- AgentRequestExecutors contract and bind-time checks from src/run-agent.ts -->

A **host** is the code that runs an agent machine and supplies the functions that call a model. The machine decides what to ask; the host executes the ask. The machine never talks to a model directly.

Those functions are the **executors**, typed as `AgentRequestExecutors`:

- `generateText(request)` returns `{ output }`, where `output` is the text string or the structured object. Optional passthrough fields (usage, tool calls, and so on) are allowed alongside `output`. Required only when the machine has a generate-mode text request.
- `streamText(request, info)` streams chunks through `info.onChunk` and returns the accumulated `{ output }`. Required only when the machine has a streaming request.
- `decide(request)` returns `{ event }`, the one event the model chose. Required only when the machine has a decision.

`runAgent` checks these at bind time, before any actor runs, so a machine that needs `decide` without one fails immediately rather than mid-run. A machine with only plain actors needs no executors at all. Each executor is a plain async function taking a plain request object, so any SDK or a raw `fetch` can back it. The machine has no idea which one you used.

## The shipped AI SDK adapter

<!-- createAiSdkExecutors surface from src/ai-sdk/index.ts -->

`createAiSdkExecutors` from `@statelyai/agent/ai-sdk` is the one adapter this package ships. It builds the `{ generateText, streamText, decide }` set from the Vercel AI SDK, mapping requests onto `generateText`/`streamText` and, for decisions, onto a tool-forced `generateText` call.

```ts
import { createAiSdkExecutors } from '@statelyai/agent/ai-sdk';
import { openai } from '@ai-sdk/openai';

const models = { quick: openai('gpt-5.4-mini') } as const;

const result = await runAgent(machine, {
  input: { prompt: 'Why state machines?' },
  ...createAiSdkExecutors({ models }),
});
```

`ai` is an optional peer dependency, imported only by this subpath. Core has one runtime peer, `xstate`. You supply the model resolver, so no provider package becomes a dependency either.

## Typed model aliases

Prefer model aliases shared between `setupAgent` and the adapter: pass one `models` map to both, and request `model:` values are typed against its keys.

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

await runAgent(machine, {
  input,
  ...createAiSdkExecutors({ models }),
});
```

For a fully dynamic or externally configured host — one whose machine must not name concrete models — use `resolveModel` instead: it takes the raw ref string and returns a model, so refs like `"openai/gpt-5.4-mini"` resolve without a static map. You can pass both; `resolveModel` wins. With `models` alone, an unknown ref throws. This is the max-portability escape hatch — see [Which authoring form when](machines.md#which-authoring-form-when).

Model refs are opaque strings, so any string is a legal `model:` value. A `models` map is optional: it gives you key autocomplete on request `model:` fields and a place for the executor to resolve those refs. The AI SDK adapter resolves a ref through its `models` map, or through `resolveModel` when the map has no match.

## Multi-step tool loops

A text request runs a single model call by default. Set `metadata.maxSteps` on the request to allow a bounded tool-call loop; the adapter forwards it as `stopWhen: stepCountIs(maxSteps)`. This is adapter behavior, not core behavior: `metadata` is the host-owned per-call channel.

## Writing your own executors

The contract is three plain functions, so a raw `fetch` is enough:

```ts
import type { AgentRequestExecutors } from '@statelyai/agent';

const executors: AgentRequestExecutors = {
  generateText: async (request) => {
    const res = await fetch('https://api.example.com/v1/generate', {
      method: 'POST',
      body: JSON.stringify({ model: request.model, prompt: request.prompt }),
    });
    return { output: await res.text() };
  },
};

await runAgent(machine, { input, ...executors });
```

This is backed by real implementations against four runtimes:

- [examples/ai-sdk-host/index.ts](../examples/ai-sdk-host/index.ts): the Vercel AI SDK, through the shipped adapter.
- [examples/openai-sdk-host/index.ts](../examples/openai-sdk-host/index.ts): the raw `openai` package (Chat Completions), structured output via `response_format`, decisions forced with `tool_choice: 'required'`.
- [examples/anthropic-sdk-host/index.ts](../examples/anthropic-sdk-host/index.ts): the raw `@anthropic-ai/sdk` package (Messages API), structured output via a forced tool call, decisions forced with `tool_choice: { type: 'any' }`.
- [examples/cloudflare-agent-host/index.ts](../examples/cloudflare-agent-host/index.ts) and [examples/cloudflare-workers-ai-host/index.ts](../examples/cloudflare-workers-ai-host/index.ts): inside a Cloudflare Durable Object and against the Workers AI binding.

## Observation seams

<!-- onTrace/onChunk/onResult/onTransition/on signatures from src/run-agent.ts -->

`runAgent` exposes purely observational callbacks; they return `void` and cannot control the run:

- **`onTrace(event)`**: one ordered stream of run/request/chunk/transition/emit/end events, with `runId`, `seq`, and `timestamp`. This is the eval trace / JSONL / telemetry-adapter slot.
- **`onChunk(chunk, info)`**: each streamed chunk of a `mode: 'stream'` request, with the `AgentRequest` that produced it (parallel streams stay distinguishable).
- **`onResult(request, result)`**: once per resolved text or decision request (decision retries fire per attempt), with the normalized `result.output` and the raw executor result. `result.raw` is whatever your executor returned, verbatim: return `usage` alongside `output` and `onResult` becomes your token meter. The shipped adapter already does this (`raw as AiSdkGenerateResult` carries `usage`, `finishReason`, `toolCalls`, `toolResults`).
- **`onTransition(snapshot, event)`**: every machine transition, with the new snapshot and the causing event.
- **`on: { EVENT: handler, '*': handler }`**: events the machine emits with `enq.emit(...)`, keyed by emitted event type (`'*'` catches all).
- **`inspect(inspectionEvent)`**: raw xstate inspection passthrough for the whole actor system. `onTransition` covers the root machine only; when a state invokes a child machine (see [multi-agent](multi-agent.md)), filter `inspectionEvent.type === '@xstate.transition'` and read `inspectionEvent.actorRef` to watch the child's states too, attributed to the child.

```ts
await runAgent(machine, {
  input,
  ...executors,
  onTrace: (event) => jsonl.write(event),
  onChunk: (chunk, info) => process.stdout.write(chunk),
  onResult: (request, result) => log(request.id, result.raw),
  onTransition: (snapshot, event) => trace(snapshot.value, event.type),
  on: { EVALUATED: (e) => console.log(`score ${e.qualityScore}/10`) },
});
```

The split: `onTrace` is the whole ordered run ledger, useful for evals and exports. `onTransition` narrates the machine in xstate's vocabulary (state values, events), for targeted tracing and debugging. `on` narrates in *your* vocabulary: the machine emits domain progress events at moments the author chose, and the host renders them (a progress UI, an SSE stream, a log line). Declare their schemas in `setupAgent` and both `enq.emit(...)` and the `on` handlers are fully typed:

```ts
const agent = setupAgent({
  context: z.object({ /* ... */ }),
  emitted: {
    EVALUATED: z.object({ qualityScore: z.number(), iteration: z.number() }),
  },
  // ...
});

// In the machine, from any transition or entry function:
onDone: ({ context, output }, enq) => {
  enq.emit({ type: 'EVALUATED', qualityScore: output.score, iteration: context.iteration });
  return { target: 'checking', context: { evaluation: output } };
},
```

Emitted events are fire-and-forget observation, not control flow: they never target states, and a run behaves identically with no handlers attached.

> **Note:** Tracing and OpenTelemetry are bring-your-own; no exporter ships. Build one on `onTrace`, or keep using the narrower seams (`onResult`, `onTransition`, `on`, `onChunk`) when a host wants separate handlers.

## Testing with deterministic executors

<!-- withExecutor test binding from src/text-logic.ts and examples/email-drafter -->

Because executors are plain functions, a test can supply scripted ones and never touch the network. Bind them with `withExecutor`:

```ts
const machine = emailDrafter.provide({
  actorSources: {
    draftEmail: draftEmail.withExecutor(async ({ request }) => {
      return { output: { to: 'sam@example.com', subject: 'Hello', body: 'Hi Sam!' } };
    }),
  },
});
```

[examples/email-drafter/index.ts](../examples/email-drafter/index.ts) drives a full run this way in its tests: fixed values, deterministic, no model called.

## Related

- [The step path](steps.md): the lower-level per-model-call checkpointing loop for durable hosts.
- [Quickstart](quickstart.md): a host and a machine together end to end.
