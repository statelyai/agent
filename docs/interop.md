---
title: Using with other stacks
description: Reuse models and executors from other AI frameworks via AI SDK LanguageModel objects, raw ai functions, and OpenAI-compatible endpoints.
---

## Models are the interop currency

An agent machine never talks to a model directly. It builds requests, and the **host** supplies executors that run them (see [Hosts and executors](./hosts)). So interop is really about where the executors come from, and the shared currency is the AI SDK **`LanguageModel`** object.

Whatever framework hands you a `LanguageModel`, drop it into `createAiSdkExecutors({ models })` and you have a full `{ generateText, streamText, decide }` set:

```ts
import { createAiSdkExecutors } from "@statelyai/agent/ai-sdk";

const executors = createAiSdkExecutors({
  models: { quick: someLanguageModel, careful: anotherLanguageModel },
});

await runAgent(machine, { input, executors });
```

Three ways in, from most to least capable:

- **AI SDK adapter.** Any `LanguageModel` (Mastra, Cloudflare Workers AI via `workers-ai-provider`, TanStack AI, OpenRouter's AI SDK provider, any `@ai-sdk/*` package). Full support, including `decide`.
- **OpenAI-compatible.** `createOpenAiCompatExecutors({ baseUrl, apiKey })` for any OpenAI-shaped endpoint (Groq, Ollama, vLLM, Together, LM Studio). Full support, including `decide`.
- **Raw `ai` functions.** Pass `ai`'s `generateText`/`streamText` as your `executors` set. Text only: `decide` needs an adapter, and structured output is best-effort.

## Recipe: reuse a Mastra model

Mastra agents are configured with an AI SDK `LanguageModel`. Reuse that same model object as an executor, with no re-config and no second provider setup:

```ts
import { openai } from "@ai-sdk/openai";
import { createAiSdkExecutors } from "@statelyai/agent/ai-sdk";

// The model you already pass to `new Agent({ model })` in Mastra.
const model = openai("gpt-5.4-mini");

await runAgent(machine, {
  input,
  executors: createAiSdkExecutors({ models: { quick: model } }),
});
```

Anything exposing a `LanguageModel` works the same way, so the machine and Mastra share one model definition.

## Recipe: Cloudflare Workers AI

`workers-ai-provider` turns a Workers AI binding into an AI SDK provider, so its models are ordinary `LanguageModel` objects:

```ts
import { createWorkersAI } from "workers-ai-provider";
import { createAiSdkExecutors } from "@statelyai/agent/ai-sdk";

export default {
  async fetch(request, env) {
    const workersai = createWorkersAI({ binding: env.AI });
    const result = await runAgent(machine, {
      input: await request.json(),
      executors: createAiSdkExecutors({
        models: { quick: workersai("@cf/meta/llama-3.1-8b-instruct") },
      }),
    });
    return Response.json(result);
  },
};
```

Pass Cloudflare-specific per-call options through request `metadata`: the host owns it, the machine just carries it.

## Recipe: local Ollama via openai-compat

Ollama serves an OpenAI-compatible API. No provider package needed, just point at the local endpoint:

```ts
import { createOpenAiCompatExecutors } from "@statelyai/agent/openai-compat";

await runAgent(machine, {
  input,
  executors: createOpenAiCompatExecutors({
    baseUrl: "http://localhost:11434/v1",
    apiKey: "ollama", // Ollama ignores it, but the field is required.
  }),
});
```

Swap `baseUrl`/`apiKey` for Groq, vLLM, Together, or LM Studio and the executors are the same.

## What each path supports

| Path                          | `generateText` | `streamText` | `decide` | Structured output |
| ----------------------------- | -------------- | ------------ | -------- | ----------------- |
| `createAiSdkExecutors`        | yes            | yes          | yes      | yes               |
| `createOpenAiCompatExecutors` | yes            | yes          | yes      | yes               |
| Raw `ai` functions            | yes            | yes          | no       | best-effort       |

`decide` maps each machine event to a forced tool call, and that mapping lives in an adapter, so raw `ai` functions cannot back a decision. For reliable structured output, use one of the two adapters. See [Text requests](./text-requests) and [Decisions](./decisions) for what each request type needs.
