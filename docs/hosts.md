# Hosts and executors

The machine owns agent control flow. A host supplies model request executors.

```ts no-check
const result = await runAgent(machine, {
  input,
  executors: {
    generateText: async (request, { signal }) => {
      const response = await mySdk.generate({
        model: request.model,
        prompt: request.prompt,
        signal
      });
      return { output: response.text, messages: response.messages };
    }
  }
});
```

Text, stream, and decision executors all receive `(request, info)`; cancellation is `info.signal`.

## Idempotency keys

Execution is at-least-once. A host runs the request and then journals its completion, so a crash between the two re-executes the request on resume. `runAgent({ store, threadId })` makes the log durable *before* each call, which bounds the duplicate to the one call that was in flight; it does not remove it.

`info.callKey` makes the duplicate safe to drop. Its format is `<executionId>:<requestId>#<n>`:

- `executionId` is the log's lineage id, pinned in the reserved `@agent.init` entry's `metadata` and inherited by every resume.
- `requestId` is the invoke site, and `n` counts that site's completions in the log — each iteration of a looped state gets its own key.
- A decision retry appends its attempt ordinal: `<executionId>:<requestId>#<n>.<attempt>`, where `attempt` is the number of prior failed attempts. Each retry is a different request, so it gets a different key.
- A resumed run re-executing an in-flight request passes the same `callKey` as the original attempt.
- A fork copies the init entry, so it keeps the parent's lineage id and can reuse results cached under the parent's keys for the requests it has not changed.
- It is `undefined` off the `runAgent` path (a bare `provideExecutors` bind) and on a run with no event log.

The key names the call *site*, not the request. A fork inherits the parent's lineage id, so a fork that changes what it asks at the same invoke site produces the same key for a different request. Cache on `callKey` **and** a fingerprint of the request, and reuse the cached result only when the request also matches. Pass `callKey` to a provider as its dedupe key for that identical request:

```ts no-check
const executors = {
  generateText: async (request, info) => {
    const fingerprint = JSON.stringify([request.model, request.prompt, request.messages]);
    const cached = info.callKey ? results.get(info.callKey) : undefined;
    if (cached?.fingerprint === fingerprint) return cached.result;
    const result = await callProvider(request, { idempotencyKey: info.callKey });
    if (info.callKey) results.set(info.callKey, { fingerprint, result });
    return result;
  }
};
```

See [The event log](event-log.md).

## Optional AI SDK default

```ts no-check
import { defineModels } from "@statelyai/agent/ai-sdk";

const models = defineModels({ fast: openai("gpt-5.4-mini") });
const agent = setupAgent({ models, /* schemas and requests */ });

await runAgent(machine, { input });
```

A registry created by `defineModels` carries an optional AI SDK executor factory. Explicit executors merge over those defaults. Core does not import or require the AI SDK at runtime.

## OpenAI SDK adapter

`@statelyai/agent/openai` maps the same three executors onto the raw `openai` package's Chat Completions API, with no AI SDK in between.

```sh
pnpm add openai
```

```ts
import OpenAI from "openai";
import { createOpenAiExecutors } from "@statelyai/agent/openai";

const executors = createOpenAiExecutors({
  client: new OpenAI(),
  resolveModel: (modelRef) => (modelRef === "deep" ? "gpt-5.4" : "gpt-5.4-mini"),
  settings: {
    deep: { reasoning_effort: "high" }
  }
});

await runAgent(machine, { input, executors });
```

`client` is injected, so the API key, base URL, and transport stay with the host. `openai` is an optional peer dependency, accepted at `>=5.0.0 <8`, and is imported for types only.

`resolveModel` maps a machine's model ref to a real OpenAI model id. It defaults to identity, for machines whose refs are already ids.

`settings` carries the provider knobs that belong to the host rather than the machine, such as `reasoning_effort` or `service_tier`. Key it by model ref to give a ref a persona, or pass a function of the request to vary settings per call. Settings merge under what the request declared, so a request that set `maxOutputTokens` wins.

Structured output goes through `response_format: { type: 'json_schema' }` around the `{ result, reasoning? }` envelope, and is unwrapped before the machine validates it. Decisions force a tool call with `tool_choice: 'required'`, one function tool per candidate event.

`generateText` runs the tool loop host-side. Each step that comes back with tool calls runs the request's tools, appends the assistant `tool_calls` message and one tool message per result, and asks again. The request's `maxSteps` bounds the number of OpenAI calls; the default is one, so a single-step request behaves as before. A tool that throws goes back to the model as an error result. The loop also ends early on a tool with no `execute` — a client-side tool, whose call is handed back with `finishReason: 'tool-calls'` and the raw response. Every step's `usage` is summed onto the one result the run aggregates.

`toolChoice` maps onto `tool_choice`: `'auto'`, `'none'`, and `'required'` pass through, and `{ type: 'tool', name }` becomes `{ type: 'function', function: { name } }`. It is sent on the first step only, so a forced choice cannot re-fire every step and burn the step budget.

Messages map part by part. Text and image parts become OpenAI content parts (`image_url`, with bytes and bare base64 wrapped in a data URL), assistant tool-call parts become `tool_calls`, and tool results become tool messages carrying their `tool_call_id`. A part Chat Completions cannot carry, such as a file part, throws rather than being dropped.

`streamText` is text-only. A request that declares tools or a structured output schema is refused, not silently downgraded; route it to `generateText`.

Every result reports `usage` on the flat `AgentCallUsage` field names, with `reasoning_tokens` and `cached_tokens` folded onto `reasoningTokens` and `cachedInputTokens`, plus the normalized `finishReason` and the untouched response on `raw`. Streams ask for `stream_options: { include_usage: true }`, so a stream reports usage too.

## Finish reasons and truncation

An executor result may report `finishReason`, normalized to `'stop'`, `'length'`, `'tool-calls'`, `'content-filter'`, or `'other'`. Map the provider's own vocabulary onto those five and leave the raw value on `raw`. `runAgent` lifts the normalized reason onto the `request.end` trace event, beside `usage`.

A `'length'` finish is the host's to interpret, because only the host sees it:

- Text request: return the text the model did produce, with `finishReason: 'length'`. Do not throw.
- Structured request: there is no usable output, so throw `AgentTruncatedError` with the `cause` and, when the model produced something, `partialOutput`.

```ts
import { AgentTruncatedError } from "@statelyai/agent";
import type { AgentRequestExecutorInfo, AgentTextRequest } from "@statelyai/agent";

function onTruncated(
  request: AgentTextRequest,
  info: AgentRequestExecutorInfo | undefined,
  partialText: string,
  cause: unknown
): never {
  // `request.name` is optional, and `requestName` is required.
  const requestName = request.name ?? "(unnamed)";
  throw new AgentTruncatedError(`Request '${requestName}' hit the output token limit.`, {
    requestName,
    requestId: info?.requestId,
    partialOutput: partialText,
    cause
  });
}
```

The error's code is `'truncated'`, which is what a machine's `onError` branches on. Core never throws it.

## Executor-owned structured retries

Retry policy belongs to the SDK or host executor. For example, a host may retry a tool-free AI SDK structured-output failure once while preserving the runner's abort signal:

```ts no-check
import { NoObjectGeneratedError } from "ai";

const aiSdk = createAiSdkExecutors({ models });
const executors = {
  ...aiSdk,
  generateText: async (request, info) => {
    try {
      return await aiSdk.generateText(request, info);
    } catch (error) {
      const hasTools = Object.keys(request.tools ?? {}).length > 0;
      if (hasTools || !NoObjectGeneratedError.isInstance(error)) throw error;
      return aiSdk.generateText(request, info);
    }
  }
};
```

Tool-bearing calls are not retried here because tools may have side effects. Use the framework's own interruption and retry facilities when available; Stately Agent forwards messages and execution to it.

## Uncontrolled XState actor

```ts no-check
const bound = provideExecutors(machine, executors);
const actor = createActor(bound, { input });
actor.start();
```

## One request

`executeAgentRequest` runs an individual typed request. It is useful in evals and raw SDK adapters without inventing a second machine lifecycle.

Framework-owned concerns—storage, durable execution, retries, queues, and tool-loop interruption recovery—remain with the framework.
