---
title: Models and providers
description: Reuse models and executors from other AI frameworks via AI SDK LanguageModel objects, raw ai functions, and OpenAI-compatible endpoints.
---

> **Alpha:** `@statelyai/agent` 2.0 is in alpha. APIs can change between releases; pin an exact version. Feedback: [github.com/statelyai/agent](https://github.com/statelyai/agent/issues).

This page covers how to supply models to a machine's [executors](hosts.md), and which capabilities each integration path supports.

## Reusing models from other frameworks

A host's [executors](hosts.md) are the only integration point. Most frameworks expose models as an AI SDK **`LanguageModel`** object. Pass that object to `createAiSdkExecutors({ models })` to get a full `{ generateText, streamText, decide }` set.

```ts
import { createAiSdkExecutors } from "@statelyai/agent/ai-sdk";

const executors = createAiSdkExecutors({
  models: { quick: someLanguageModel, careful: anotherLanguageModel },
});

await runAgent(machine, { input, executors });
```

There are four integration paths. The first two both go through `createAiSdkExecutors`, so they appear as one row in the [support table](#support-by-path).

- **AI SDK adapter.** Accepts any `LanguageModel`, including models from Mastra, Cloudflare Workers AI through `workers-ai-provider`, TanStack AI, OpenRouter's AI SDK provider, and any `@ai-sdk/*` package. Supports all three executors, including `decide`.
- **OpenAI-compatible endpoints.** Point `createOpenAI({ baseURL })` from `@ai-sdk/openai` at any OpenAI-shaped endpoint, such as Groq, Ollama, vLLM, Together, or LM Studio, then pass the result to the same adapter. Supports all three executors, including `decide`.
- **Hand-written executors.** Write the three executors yourself against a provider's HTTP API, or against a client that is not an AI SDK `LanguageModel`, such as a LangChain `BaseChatModel`. Supports all three executors, but you map structured output and decision retries yourself. See [Hosts](hosts.md) and [LangChain models](#langchain-models).
- **Raw `ai` functions.** Pass the `ai` package's `generateText` and `streamText` as your `executors` set. This path supports text only. `decide` requires the adapter, and structured output is best-effort.

<!-- viz: executor sourcing paths: LanguageModel object -> createAiSdkExecutors -> { generateText, streamText, decide }, with the raw-`ai` path bypassing the adapter and losing decide/structured output -->

## Host-owned model settings

<!-- settings and model-entry precedence from src/ai-sdk/index.ts and src/ai-sdk/mappers.ts -->

Pass provider-specific settings to `createAiSdkExecutors`, not the machine. An object applies to every call; a function can vary settings by request. A model entry may also pair one model with its defaults.

```ts
const executors = createAiSdkExecutors({
  models: {
    quick: openai("gpt-5.4-mini"),
    careful: { model: openai("gpt-5.4"), settings: { reasoning: "high" } },
  },
  settings: (request) => ({ temperature: request.name === "draft" ? 0.7 : 0 }),
});
```

Precedence is global `settings`, then model-entry settings, then portable generation fields declared by the request.

## Mastra models

Mastra is a TypeScript agent framework that configures agents with an AI SDK `LanguageModel`. Pass the same models to `createAiSdkExecutors`, and expose the run through a Mastra tool.

```ts
import { z } from "zod";
import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { createAiSdkExecutors } from "@statelyai/agent/ai-sdk";
import { runAgent } from "@statelyai/agent";

const executors = createAiSdkExecutors({ models });

const startWorkflow = createTool({
  id: "start_workflow",
  description: "Start the drafting workflow from the user's request.",
  inputSchema: z.object({ prompt: z.string() }),
  outputSchema: z.object({ status: z.string() }),
  execute: async ({ prompt }) => {
    const result = await runAgent(machine, { input: { prompt }, executors });
    return { status: result.status };
  },
});

export const hostAgent = new Agent({
  id: "drafting-host",
  name: "Drafting Host",
  instructions: "Call start_workflow with the user's request, then report what came back.",
  model: "openai/gpt-5.4-mini",
  tools: { start_workflow: startWorkflow },
});
```

Any framework that exposes a `LanguageModel` works the same way. The machine and the Mastra agent share one model definition. See [`examples/mastra-host`](https://github.com/statelyai/agent/tree/main/examples/mastra-host) for the full bridge, including pause and resume across tool calls.

## LangChain models

LangChain chat models are not AI SDK `LanguageModel` objects, so they take the hand-written path. Wrap any `BaseChatModel` in the three executors and the machine keeps LangChain's model config, callbacks, and retries.

- `generateText` and `streamText` call the model's `invoke` and `stream`.
- `decide` binds one tool per allowed event and forces a tool call.
- LangSmith tracing is env-var driven, so a wrapped model traces without code changes. For tracing the machine's own spans instead, see [Observability](observability.md).

See [`examples/langchain-host`](../examples/langchain-host/index.ts) for both directions: LangChain models as executors, and the machine handed to a LangChain `createAgent` loop as `start_workflow` and `resume_workflow` tools.

## Cloudflare Workers AI

Workers AI runs models on Cloudflare's edge and is reached through a binding on the Worker's `env`. The `workers-ai-provider` package turns that binding into an AI SDK provider, so its models are ordinary `LanguageModel` objects.

```ts no-check
import { createWorkersAI } from "workers-ai-provider";
import { createAiSdkExecutors } from "@statelyai/agent/ai-sdk";

export default {
  async fetch(request, env) {
    // Model IDs here are illustrative; substitute your provider's current models.
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

Pass Cloudflare-specific per-call options through request `metadata`. The host reads `metadata`; the machine only carries it.

## Ollama and OpenAI-compatible endpoints

Ollama runs models locally and serves them over an OpenAI-compatible HTTP API. Point the AI SDK's OpenAI provider at the local endpoint. `apiKey` is optional; omit it for keyless local servers.

```ts
import { createOpenAI } from "@ai-sdk/openai";
import { createAiSdkExecutors } from "@statelyai/agent/ai-sdk";

// Model IDs here are illustrative; substitute your provider's current models.
const ollama = createOpenAI({ baseURL: "http://localhost:11434/v1" });

await runAgent(machine, {
  input,
  executors: createAiSdkExecutors({
    models: { quick: ollama("llama3.1") },
  }),
});
```

To use Groq, vLLM, Together, OpenRouter, or LM Studio, change `baseURL` and add `apiKey` where the endpoint requires one. Nothing else changes.

To avoid depending on `ai`, write the three executors over raw `fetch` against the same Chat Completions endpoint. Build the request body from the plain `AgentTextRequest` fields. Use `buildEnvelopeSchema`, `getJsonSchema`, and `parseOutput` from `@statelyai/agent` for structured output, and `renderDecisionAttempts` for decision retries. See [Hosts](hosts.md).

## Raw AI SDK functions

The `generateText` and `streamText` executors accept the raw Vercel AI SDK functions directly. No adapter is needed.

```ts
import { generateText, streamText } from "ai";

await runAgent(machine, { input, executors: { generateText, streamText } });
```

An `AgentTextRequest` is spread-compatible with the AI SDK's call options. Result shapes unwrap natively: `{ text }` for `generateText`, and `{ textStream }` for `streamText`, whose final text is available via `await result.text`. This path has two limits.

- Structured output is best-effort. A request with an `outputSchema` has its raw text parsed with `JSON.parse` and then validated. A parse failure throws. Use `createAiSdkExecutors` for reliable structured output.
- `decide` requires the adapter. The tool-per-event mapping lives in the adapter, and there is no raw AI SDK function for it.

## Support by path

| Path                   | `generateText` | `streamText` | `decide` | Structured output |
| ---------------------- | -------------- | ------------ | -------- | ----------------- |
| `createAiSdkExecutors` | yes            | yes          | yes      | yes               |
| Hand-written executors | yes            | yes          | yes      | yes (you map it)  |
| Raw `ai` functions     | yes            | yes          | no       | best-effort       |

The `decide` executor maps each machine event to a forced tool call. That mapping lives in the adapter layer, so raw `ai` functions cannot back a decision. For reliable structured output, use `createAiSdkExecutors` or map the envelope yourself. See [Text requests](text-requests.md) and [Decisions](decisions.md).

## Reference hosts by provider

Each example is a runnable host for one provider stack.

| Example                                                                       | Backing                                                                                                           |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| [ai-sdk-game-host](../examples/ai-sdk-game-host/index.ts)                     | Vercel AI SDK, through the optional adapter                                                                       |
| [openai-sdk-host](../examples/openai-sdk-host/index.ts)                       | raw `openai` (Chat Completions); structured via `response_format`, decisions via `tool_choice: 'required'`        |
| [anthropic-sdk-host](../examples/anthropic-sdk-host/index.ts)                 | raw `@anthropic-ai/sdk` (Messages); structured via forced tool call, decisions via `tool_choice: { type: 'any' }` |
| [langchain-host](../examples/langchain-host/index.ts)                         | LangChain `BaseChatModel` (`@langchain/core`), wrapped into the executor contract                                 |
| [mastra-host](../examples/mastra-host/index.ts)                               | Mastra `Agent` and `createTool`, bridging to `runAgent`                                                           |
| [cloudflare-agent-host](../examples/cloudflare-agent-host/index.ts)           | Durable Object                                                                                                    |
| [cloudflare-workers-ai-host](../examples/cloudflare-workers-ai-host/index.ts) | Workers AI binding                                                                                                |
