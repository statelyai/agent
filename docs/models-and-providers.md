---
title: Models and providers
description: Reuse models and executors from other AI frameworks via AI SDK LanguageModel objects, TanStack AI text adapters, and OpenAI-compatible endpoints.
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

await runAgent(machine, { executors, input });
```

## Declaring models once

When the models are already declared in `setupAgent({ models })`, pass the machine, or the setup result, instead of repeating the map. The adapter reads the models registered for that machine, including through `machine.provide(...)`.

```ts
import { z } from "zod";
import { runAgent, setupAgent } from "@statelyai/agent";
import { createAiSdkExecutors } from "@statelyai/agent/ai-sdk";

const agentSetup = setupAgent({
  context: z.object({ prompt: z.string() }),
  input: z.object({ prompt: z.string() }),
  models: { quick: someLanguageModel },
  requests: {
    write: {
      schemas: { input: z.object({ prompt: z.string() }), output: z.string() },
      model: "quick",
      prompt: ({ input }) => input.prompt,
    },
  },
});

const machine = agentSetup.createMachine({
  context: ({ input }) => input,
  initial: "writing",
  states: {
    writing: {
      invoke: {
        src: "write",
        input: ({ context }) => ({ prompt: context.prompt }),
        onDone: { target: "done" },
      },
    },
    done: { type: "final" },
  },
});

await runAgent(machine, {
  input: { prompt: "Why state machines?" },
  executors: createAiSdkExecutors(machine),
});
```

- `createAiSdkExecutors(machine)` and `createAiSdkExecutors(agentSetup)` resolve the same `models`.
- `createTanStackAiExecutors` accepts the same three forms.
- Host settings still need the options form: `createAiSdkExecutors({ models: agentSetup.models, settings })`.
- Anything else throws when the executors are built, not on the first call. That includes a setup or machine that declared no models.
- Core stays provider-free: it stores the models without reading them, and only the adapter interprets them.

There are five integration paths. The first two both go through `createAiSdkExecutors`, so they appear as one row in the [support table](#support-by-path).

- **AI SDK adapter.** Accepts any `LanguageModel`, including models from Mastra, Cloudflare Workers AI through `workers-ai-provider`, OpenRouter's AI SDK provider, and any `@ai-sdk/*` package. Supports all three executors, including `decide`.
- **OpenAI-compatible endpoints.** Point `createOpenAI({ baseURL })` from `@ai-sdk/openai` at any OpenAI-shaped endpoint, such as Groq, Ollama, vLLM, Together, or LM Studio, then pass the result to the same adapter. Supports all three executors, including `decide`.
- **TanStack AI adapter.** `createTanStackAiExecutors` from `@statelyai/agent/tanstack-ai` accepts any TanStack AI text adapter, such as `openaiText` or `anthropicText`. Supports all three executors, including `decide`. See [Hosts](hosts.md#tanstack-ai-adapter).
- **Hand-written executors.** Write the three executors yourself against a provider's HTTP API, or against a client that is not an AI SDK `LanguageModel`, such as a LangChain `BaseChatModel`. Supports all three executors, but you map structured output and decision retries yourself. See [Hosts](hosts.md) and [LangChain models](#langchain-models).
- **Raw `ai` functions.** Pass the `ai` package's `generateText` and `streamText` as your `executors` set. This path supports text only. `decide` requires the adapter, and structured output is best-effort.

<!-- viz: executor sourcing paths: LanguageModel object -> createAiSdkExecutors -> { generateText, streamText, decide } -->

## Host-owned model settings

<!-- settings and model-entry precedence from src/ai-sdk/index.ts (textParams), src/ai-sdk/mappers.ts and src/internal/model-source.ts (resolveModelEntry, resolveHostSettings) -->

Pass provider-specific settings to `createAiSdkExecutors`, not the machine. An object applies to every call; a function can vary settings by request. A model entry may also pair one model with its defaults.

```ts
const executors = createAiSdkExecutors({
  models: {
    quick: openai("gpt-6-luna"),
    careful: { model: openai("gpt-6.1-sol"), settings: { reasoning: "high" } },
  },
  settings: (request) => ({ temperature: request.name === "draft" ? 0.7 : 0 }),
});
```

Precedence is global `settings`, then model-entry settings, then portable generation fields declared by the request.

## Decision models

<!-- decision-model entries from src/ai-sdk/index.ts (decideWithDecisionModel) -->

An AI SDK decision model, such as TypeSafe's Jev, goes in the same models map as the language models. A decide request whose model ref names it is answered through `experimental_decide` instead of a tool call.

```ts no-check
import { openai } from "@ai-sdk/openai";
import { typeSafeAi } from "@ai-sdk/typesafe-ai";

const executors = createAiSdkExecutors({
  models: { desk: openai("gpt-6-luna"), judge: typeSafeAi.decisionModel("jev-latest") },
});
```

- The request must be a closed choice: `payloads` on `agent.decide`, or `decideNext`. A request without `options` throws.
- The adapter asks one `choice` question. Each option id is a label, and its criterion is the option's description, or the event as JSON when it has none. The instructions are the request's `system` and `prompt`, and the state is the request's `input`.
- The result carries the chosen option's event, the call's usage, and `confidence` when the model reports it.
- A label that is not an option is a failed attempt, retried like any other. A retry appends each earlier attempt's reason to the instructions.
- A text request on a decision model throws. Host `settings` apply to language models only.
- `resolveModel` may return a decision model too.

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
    const result = await runAgent(machine, { executors, input: { prompt } });
    return { status: result.status };
  },
});

export const hostAgent = new Agent({
  id: "drafting-host",
  name: "Drafting Host",
  instructions: "Call start_workflow with the user's request, then report what came back.",
  model: "openai/gpt-6-luna",
  tools: { start_workflow: startWorkflow },
});
```

Any framework that exposes a `LanguageModel` works the same way. The machine and the Mastra agent share one model definition. See [`examples/mastra-host`](https://github.com/statelyai/agent/tree/next/examples/mastra-host) for the full bridge, including pause and resume across tool calls.

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
    const result = await runAgent(machine, { executors: createAiSdkExecutors({
          models: { quick: workersai("@cf/meta/llama-3.1-8b-instruct") },
        }), input: await request.json() });
    return Response.json(result);
  },
};
```

Pass Cloudflare-specific per-call options through request `metadata`. The host reads `metadata`; the machine only carries it.

## Ollama and OpenAI-compatible endpoints

Ollama runs models locally and serves them over an OpenAI-compatible HTTP API. Point the AI SDK's OpenAI provider at the local endpoint. Pass a placeholder `apiKey`: the provider throws while building request headers when neither `apiKey` nor `OPENAI_API_KEY` is set, even for a local server that ignores the value.

```ts
import { createOpenAI } from "@ai-sdk/openai";
import { createAiSdkExecutors } from "@statelyai/agent/ai-sdk";

// Model IDs here are illustrative; substitute your provider's current models.
const ollama = createOpenAI({ baseURL: "http://localhost:11434/v1", apiKey: "ollama" });

await runAgent(machine, { executors: createAiSdkExecutors({
      models: { quick: ollama("llama3.1") },
    }), input });
```

To use Groq, vLLM, Together, OpenRouter, or LM Studio, change `baseURL` and use the endpoint's real `apiKey`. Nothing else changes.

For OpenAI itself, `@statelyai/agent/openai` maps the three executors onto the raw `openai` package's Chat Completions API, with no `ai` dependency. See [Hosts](hosts.md#openai-sdk-adapter).

To avoid depending on `ai` or `openai`, write the three executors over raw `fetch` against the same Chat Completions endpoint. Build the request body from the plain `AgentTextRequest` fields. For structured output, `providerOutputSchema` and `getJsonSchema` from `@statelyai/agent` build the `{ result, reasoning? }` schema to send; on the way back, `parseProviderOutput` validates the model's JSON against it and returns `{ result, reasoning? }`, which is already the shape an executor returns. Use `parseOutput` when you validate a bare value on its own, against the schema the request declared. Use `renderDecisionAttempts` for decision retries. See [Hosts](hosts.md).

## Testing with a mock model

To exercise the adapter path itself without a provider, put one of the AI SDK's own mock models from `ai/test` in the `models` map.

```ts
import { MockLanguageModelV3 } from "ai/test";
import { createAiSdkExecutors } from "@statelyai/agent/ai-sdk";

const executors = createAiSdkExecutors({
  models: {
    fast: new MockLanguageModelV3({
      doGenerate: async () => ({
        content: [{ type: "text", text: "Because transitions constrain behavior." }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        warnings: [],
      }),
    }),
  },
});
```

When the adapter is not what is under test, a plain function executor that routes on `request.name` is lighter. See [Evals](evals.md#plain-function-executors).

## Support by path

| Path                        | `generateText` | `streamText` | `decide` | Structured output |
| --------------------------- | -------------- | ------------ | -------- | ----------------- |
| `createAiSdkExecutors`      | yes            | yes          | yes      | yes               |
| `createOpenAiExecutors`     | yes            | yes          | yes      | yes               |
| `createTanStackAiExecutors` | yes            | yes          | yes      | yes               |
| Hand-written executors      | yes            | yes          | yes      | yes (you map it)  |

The `decide` executor maps each machine event to a forced tool call, or a closed choice to one tool over the option ids (one `choice` question for a decision model), and structured output is requested as `{ result, reasoning? }`. Both live in the adapter layer, so an executor is either an adapter's or a function of yours that returns `{ result }`. See [Text requests](text-requests.md) and [Decisions](decisions.md).

## Reference hosts by provider

Each example is a runnable host for one provider stack.

| Example                                                                       | Backing                                                                                                           |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| [ai-sdk-host](../examples/ai-sdk-host/index.ts)                               | Vercel AI SDK, through the optional adapter                                                                       |
| [openai-sdk-host](../examples/openai-sdk-host/index.ts)                       | `createOpenAiExecutors` from `@statelyai/agent/openai`, over the raw `openai` package (Chat Completions)          |
| [tanstack-ai-stream](../examples/tanstack-ai-stream/index.ts)                 | `createTanStackAiExecutors` from `@statelyai/agent/tanstack-ai`, streamed to a `useChat` client over AG-UI        |
| [anthropic-sdk-host](../examples/anthropic-sdk-host/index.ts)                 | raw `@anthropic-ai/sdk` (Messages); structured via forced tool call, decisions via `tool_choice: { type: 'any' }` |
| [langchain-host](../examples/langchain-host/index.ts)                         | LangChain `BaseChatModel` (`@langchain/core`), wrapped into the executor contract                                 |
| [mastra-host](../examples/mastra-host/index.ts)                               | Mastra `Agent` and `createTool`, bridging to `runAgent`                                                    |
| [cloudflare-agent-host](../examples/cloudflare-agent-host/index.ts)           | Durable Object                                                                                                    |
| [cloudflare-workers-ai-host](../examples/cloudflare-workers-ai-host/index.ts) | Workers AI binding                                                                                                |
