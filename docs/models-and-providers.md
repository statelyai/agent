---
title: Models and providers
description: Reuse models and executors from other AI frameworks via AI SDK LanguageModel objects, raw ai functions, and OpenAI-compatible endpoints.
---

> **Alpha:** `@statelyai/agent` 2.0 is in alpha. APIs can change between releases; pin an exact version. Feedback: [github.com/statelyai/agent](https://github.com/statelyai/agent/issues).

## Reusing models from other frameworks

Where a host's [executors](hosts.md) come from is the only integration point. The shared type across frameworks is the AI SDK **`LanguageModel`** object: whatever framework hands you one, drop it into `createAiSdkExecutors({ models })` for a full `{ generateText, streamText, decide }` set:

```ts
import { createAiSdkExecutors } from "@statelyai/agent/ai-sdk";

const executors = createAiSdkExecutors({
  models: { quick: someLanguageModel, careful: anotherLanguageModel },
});

await runAgent(machine, { input, executors });
```

Three ways in, from most to least capable:

- **AI SDK adapter.** Any `LanguageModel` (Mastra, Cloudflare Workers AI via `workers-ai-provider`, TanStack AI, OpenRouter's AI SDK provider, any `@ai-sdk/*` package). Full support, including `decide`.
- **OpenAI-compatible endpoints.** Point `createOpenAI({ baseURL })` from `@ai-sdk/openai` at any OpenAI-shaped endpoint (Groq, Ollama, vLLM, Together, LM Studio) and feed the result to the same adapter. Full support, including `decide`.
- **Raw `ai` functions.** Pass `ai`'s `generateText`/`streamText` as your `executors` set. Text only: `decide` needs an adapter, and structured output is best-effort.

## Recipe: reuse a Mastra model

Mastra agents are configured with an AI SDK `LanguageModel`. Reuse that same model object as an executor, no re-config and no second provider setup:

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

Anything exposing a `LanguageModel` works the same way, so machine and Mastra share one model definition.

## Recipe: Cloudflare Workers AI

The `workers-ai-provider` package turns a Workers AI binding into an AI SDK provider, so its models are ordinary `LanguageModel` objects:

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

## Recipe: local Ollama and other OpenAI-compatible endpoints

Ollama serves an OpenAI-compatible API, so the AI SDK's OpenAI provider pointed at the local endpoint is enough. `apiKey` is optional: omit it for keyless local servers.

```ts
import { createOpenAI } from "@ai-sdk/openai";
import { createAiSdkExecutors } from "@statelyai/agent/ai-sdk";

const ollama = createOpenAI({ baseURL: "http://localhost:11434/v1" });

await runAgent(machine, {
  input,
  executors: createAiSdkExecutors({
    models: { quick: ollama("llama3.1") },
  }),
});
```

Swap `baseURL` (and add `apiKey` where the endpoint requires one) for Groq, vLLM, Together, OpenRouter, or LM Studio; nothing else changes.

If you would rather not depend on `ai` at all, write the three executors over raw `fetch` against the same Chat Completions endpoint: build the request body from the plain `AgentTextRequest` fields, and use `buildEnvelopeSchema`, `getJsonSchema`, and `parseOutput` from `@statelyai/agent` for structured output, plus `renderDecisionAttempts` for decision retries. See [Hosts](hosts.md#writing-your-own-executors).

## Raw AI SDK functions

The `generateText`/`streamText` executors accept the raw Vercel AI SDK functions directly, no adapter needed:

```ts
import { generateText, streamText } from "ai";

await runAgent(machine, { input, executors: { generateText, streamText } });
```

An `AgentTextRequest` is spread-compatible with the AI SDK's call options, and result shapes unwrap natively (`{ text }`; `{ textStream }`, final text via `await result.text`). Two caveats:

- **Structured output is best-effort.** A request with an `outputSchema` has its raw text `JSON.parse`d and validated; a parse failure throws. For reliable structured output, use `createAiSdkExecutors`.
- **`decide` needs an adapter.** The tool-per-event mapping lives in the adapter; there is no raw AI SDK function for it.

## What each path supports

| Path                   | `generateText` | `streamText` | `decide` | Structured output |
| ---------------------- | -------------- | ------------ | -------- | ----------------- |
| `createAiSdkExecutors` | yes            | yes          | yes      | yes               |
| Raw `fetch` executors  | yes            | yes          | yes      | yes (you map it)  |
| Raw `ai` functions     | yes            | yes          | no       | best-effort       |

The `decide` executor maps each machine event to a forced tool call, and that mapping lives in the adapter layer, so raw `ai` functions cannot back a decision. For reliable structured output, use `createAiSdkExecutors` or map the envelope yourself. See [Text requests](text-requests.md) and [Decisions](decisions.md).

## Reference hosts by provider

Runnable hosts, one per provider stack:

| Example                                                                       | Backing                                                                                                           |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| [ai-sdk-host](../examples/ai-sdk-host/index.ts)                               | Vercel AI SDK, through the shipped adapter                                                                        |
| [openai-sdk-host](../examples/openai-sdk-host/index.ts)                       | raw `openai` (Chat Completions); structured via `response_format`, decisions via `tool_choice: 'required'`        |
| [anthropic-sdk-host](../examples/anthropic-sdk-host/index.ts)                 | raw `@anthropic-ai/sdk` (Messages); structured via forced tool call, decisions via `tool_choice: { type: 'any' }` |
| [cloudflare-agent-host](../examples/cloudflare-agent-host/index.ts)           | Durable Object                                                                                                    |
| [cloudflare-workers-ai-host](../examples/cloudflare-workers-ai-host/index.ts) | Workers AI binding                                                                                                |

<!-- package entry points from package.json#exports -->

Package entry points are `@statelyai/agent` (root), `@statelyai/agent/ai-sdk`, `@statelyai/agent/machines`, `@statelyai/agent/otel`, `@statelyai/agent/sqlite`, and `@statelyai/agent/agent-workflow.json`. Everything a hand-written host needs (`buildEnvelopeSchema`, `getJsonSchema`, `parseOutput`, `parseStructuredEnvelope`, `getAgentOutputMode`, `resolveDecision`, `renderDecisionAttempts`) comes from the root.
