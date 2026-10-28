# Hosts and executors

The machine owns agent control flow. A host supplies model request executors.

```ts no-check
const result = await runToQuiescence(
  createAgentRuntime(machine, {
    executors: {
      generateText: async (request, { signal }) => {
        const response = await mySdk.generate({
          model: request.model,
          prompt: request.prompt,
          signal,
        });
        return { result: response.text, messages: response.messages };
      },
    },
  }),
  { input },
);
```

Text, stream, and decision executors all receive `(request, info)`; cancellation is `info.signal`.

## Idempotency keys

Execution is at-least-once. A host runs the request and then journals its completion, so a crash between the two re-executes the request on resume. `createAgentRuntime(machine, { store, threadId })` makes the log durable _before_ each call, which bounds the duplicate to the one call that was in flight; it does not remove it.

`info.callKey` makes the duplicate safe to drop. Its format is `<executionId>:<requestId>#<n>`:

- `executionId` is the log's lineage id, pinned in the reserved `@agent.init` entry's `metadata` and inherited by every resume.
- `requestId` is the invoke site, and `n` counts that site's completions in the log — each iteration of a looped state gets its own key. A decision counts once its chosen event is journaled, even when that event ends the invoke before it completes.
- A call inside an invoked child machine is keyed under the root-level child that owns it: `<executionId>:<childId>#<m>/<requestId>#<k>`, one `/` segment per nesting level. `m` counts the child's completions in the log, and `k` counts that site's calls within that child instance. The log holds none of the child's own events, so a resumed child restarts from its initial state and re-runs its calls under the keys they had.
- A decision retry appends its attempt ordinal: `<executionId>:<requestId>#<n>.<attempt>`, where `attempt` is the number of prior failed attempts. Each retry is a different request, so it gets a different key.
- A resumed run re-executing an in-flight request passes the same `callKey` as the original attempt.
- A fork mints its own lineage id (see [Fork](event-log.md#fork)), so none of its calls shares a key with its parent's.
- It is `undefined` off the `runToQuiescence` path (a bare `provideExecutors` bind) and on a run with no event log.

The key names the call _site_, not the request. A version bridge keeps the lineage id, so a migrated machine that asks something else at the same invoke site produces the same key for a different request. Cache on `callKey` **and** a fingerprint of the request, and reuse the cached result only when the request also matches. Pass `callKey` to a provider as its dedupe key for that identical request:

```ts no-check
const executors = {
  generateText: async (request, info) => {
    const fingerprint = JSON.stringify([request.model, request.prompt, request.messages]);
    const cached = info.callKey ? results.get(info.callKey) : undefined;
    if (cached?.fingerprint === fingerprint) return cached.result;
    const result = await callProvider(request, { idempotencyKey: info.callKey });
    if (info.callKey) results.set(info.callKey, { fingerprint, result });
    return result;
  },
};
```

See [The event log](event-log.md).

## AI SDK adapter

```ts no-check
import { createAiSdkExecutors } from "@statelyai/agent/ai-sdk";

const models = { fast: openai("gpt-6-luna") };
const agent = setupAgent({ models /* schemas and requests */ });

await runToQuiescence(
  createAgentRuntime(machine, { executors: createAiSdkExecutors({ models }) }),
  { input },
);
```

Passing the same `models` map to `setupAgent({ models })` types the machine's model refs, so a request naming a model the host does not have is a compile error. Executors are always passed explicitly. Core does not import or require the AI SDK at runtime.

## OpenAI SDK adapter

`@statelyai/agent/openai` maps the same three executors onto the raw `openai` package, with no AI SDK in between.

- Calls that carry function tools use the Responses API: every `decide`, and `generateText` with tools. Reasoning models such as `gpt-6-luna` reject function tools on Chat Completions.
- Tool-free calls use Chat Completions: `generateText` without tools, and `streamText`.

```sh
pnpm add openai
```

```ts
import OpenAI from "openai";
import { createOpenAiExecutors } from "@statelyai/agent/openai";

const executors = createOpenAiExecutors({
  client: new OpenAI(),
  resolveModel: (modelRef) => (modelRef === "deep" ? "gpt-6.1-sol" : "gpt-6-luna"),
  settings: {
    deep: { reasoning_effort: "high" },
  },
});

await runToQuiescence(createAgentRuntime(machine, { executors }), { input });
```

`client` is injected, so the API key, base URL, and transport stay with the host. `openai` is an optional peer dependency, accepted at `>=5.0.0 <8`, and is imported for types only. A client wrapper must forward both `responses.create` and `chat.completions.create`, and an OpenAI-compatible server needs `/v1/responses` for tool calls.

`resolveModel` maps a machine's model ref to a real OpenAI model id. It defaults to identity, for machines whose refs are already ids.

`settings` carries the provider knobs that belong to the host rather than the machine, such as `reasoning_effort` or `service_tier`. Key it by model ref to give a ref a persona, or pass a function of the request to vary settings per call. Settings merge under what the request declared, so a request that set `maxOutputTokens` wins. Settings use Chat Completions names. On Responses calls:

- `reasoning_effort` becomes `reasoning.effort`.
- `max_completion_tokens` becomes `max_output_tokens`.
- `verbosity` becomes `text.verbosity`.
- Settings the Responses API shares by name, such as `temperature` and `service_tier`, pass through.
- Chat-only settings, such as `seed`, `stop`, `logprobs`, and `prediction`, are dropped. This includes a request's `seed` and `stopSequences`. Each dropped key logs one `console.warn` per `createOpenAiExecutors` instance.
- `store` defaults to `false`, matching Chat Completions.

Structured output sends the declared schema wrapped as `{ result, reasoning? }`, as `response_format: { type: 'json_schema' }` on Chat Completions or `text.format` on the Responses API. The parsed `result` is what the machine validates. Decisions force a tool call with `tool_choice: 'required'`, one function tool per candidate event. Function tools are sent with `strict: false`, since the Responses API defaults strict mode on and arbitrary JSON Schema may fall outside it.

`generateText` runs the tool loop host-side. Each step that comes back with function calls runs the request's tools, appends the calls and one `function_call_output` item per result, and asks again. The replay is stateless: calls go back without their item ids, and reasoning items are left out. An incomplete turn, such as one cut off at `max_output_tokens`, never runs its calls, and an incomplete decision throws instead of choosing. The request's `maxSteps` bounds the number of OpenAI calls; the default is one, so a single-step request behaves as before. A tool that throws, a call to a tool the request did not offer, and arguments that are not JSON go back to the model as error results. The loop also ends early on a tool with no `execute` — a client-side tool, whose call is handed back with `finishReason: 'tool-calls'` and the raw response. Every step's `usage` is summed onto the one result the run aggregates.

`toolChoice` maps onto `tool_choice`: `'auto'`, `'none'`, and `'required'` pass through, and `{ type: 'tool', name }` becomes `{ type: 'function', name }`. It is sent on the first step only, so a forced choice cannot re-fire every step and burn the step budget.

Messages map part by part. Text and image parts become OpenAI content parts (`image_url`, or `input_image` on the Responses API, with bytes and bare base64 wrapped in a data URL). Assistant tool-call parts become `tool_calls`, or `function_call` items. Tool results become tool messages carrying their `tool_call_id`, or `function_call_output` items. A part the adapter cannot carry, such as a file part, throws rather than being dropped.

`streamText` is text-only. A request that declares tools or a structured output schema is refused, not silently downgraded; route it to `generateText`.

Every result reports `usage` on the flat `AgentCallUsage` field names, with `reasoning_tokens` and `cached_tokens` folded onto `reasoningTokens` and `cachedInputTokens`, plus the normalized `finishReason` and the untouched response on `raw`. A Responses API response has no `finish_reason`: an `incomplete` status maps `max_output_tokens` to `'length'`, and a completed response with function calls maps to `'tool-calls'`. Streams ask for `stream_options: { include_usage: true }`, so a stream reports usage too.

## TanStack AI adapter

`@statelyai/agent/tanstack-ai` maps the same three executors onto [TanStack AI](https://tanstack.com/ai)'s `chat()` activity. Any TanStack AI text adapter works as a model: `openaiText`, `anthropicText`, `geminiText`, `ollamaText`, and the rest.

```sh
pnpm add @tanstack/ai @tanstack/ai-openai
```

```ts no-check
import { openaiText } from "@tanstack/ai-openai";
import { anthropicText } from "@tanstack/ai-anthropic";
import { createTanStackAiExecutors } from "@statelyai/agent/tanstack-ai";

const executors = createTanStackAiExecutors({
  models: {
    quick: openaiText("gpt-6-luna"),
    deep: {
      adapter: anthropicText("claude-sonnet-5"),
      settings: { modelOptions: { thinking: { type: "enabled", budget_tokens: 4096 } } },
    },
  },
});

await runToQuiescence(createAgentRuntime(machine, { executors }), { input });
```

The options mirror `createAiSdkExecutors`:

- `models` maps model refs to text adapters, or to `{ adapter, settings }` pairs that give a ref a persona.
- `resolveModel` resolves refs dynamically, and wins over `models` when both are set.
- `settings` carries `chat()` options that belong to the host, such as `modelOptions`, `middleware`, or `metadata`. Pass an object for every call, or a function of the request.

Precedence is global `settings`, then the model entry's `settings`, then the request's own generation settings. `modelOptions` merge key by key.

TanStack AI has no portable sampling or tool-choice options; each provider adapter names its own `modelOptions`. The adapter maps a request's `temperature`, `topP`, `topK`, `maxOutputTokens`, `seed`, `stopSequences`, and `toolChoice` by provider:

- `openai`: `temperature`, `top_p`, `max_output_tokens`, and `tool_choice`. The Responses API has no `top_k`, `seed`, or `stop`, so those are dropped. TanStack AI's OpenAI adapter also drops `temperature` and `top_p` for reasoning models.
- `anthropic`: `temperature`, `top_p`, `top_k`, `max_tokens`, `stop_sequences`, and `tool_choice`. `seed` is dropped.
- `gemini`: `temperature`, `topP`, `topK`, `maxOutputTokens`, `seed`, `stopSequences`, and `toolConfig`.
- Any other provider gets none of them. Map them in a `settings` function, which receives the request.

The rest of the contract matches the other adapters:

- Structured output passes the declared schema, wrapped as `{ result, reasoning? }`, as `chat()`'s `outputSchema`. A structured run cut off by the token limit is an `AgentTruncatedError`.
- Tools run in `chat()`'s own loop, in `generateText` and `streamText` alike. The request's `maxSteps` bounds the model turns; the default is one. A tool with no `execute` stops the run at its call, with `finishReason: 'tool-calls'`.
- A forced `toolChoice` applies to the first model turn only, so the model can answer after the tool runs.
- `generateText` and `streamText` return the run's response `messages`: each turn's assistant text and tool calls, and the tool results fed back. Append them to a conversation and they replay into the next request.
- Decisions offer one tool per candidate event, with no `execute`, so the run stops at the model's first call. The tool choice is forced where the provider supports it.
- System messages and the request's `system` become `systemPrompts`, since TanStack AI messages have no `system` role. Image parts become `url` or base64 `data` sources; other part types throw.
- Every result reports `usage` summed over the run's model turns, the normalized `finishReason`, and every chunk the run produced on `raw`. A provider error arrives as a `RUN_ERROR` chunk and is thrown with its `code`.

`@tanstack/ai` is an optional peer dependency. To stream a run to a `useChat` client over TanStack AI's wire protocol, see [tanstack-ai-stream](../examples/tanstack-ai-stream).

## Finish reasons and truncation

An executor result may report `finishReason`, normalized to `'stop'`, `'length'`, `'tool-calls'`, `'content-filter'`, or `'other'`. Map the provider's own vocabulary onto those five and leave the raw value on `raw`. `runToQuiescence` lifts the normalized reason onto the `request.end` trace event, beside `usage`.

A `'length'` finish is the host's to interpret, because only the host sees it:

- Text request: return the text the model did produce, with `finishReason: 'length'`. Do not throw.
- Structured request: there is no usable output, so throw `AgentTruncatedError` with the `cause` and, when the model produced something, `partialOutput`.

```ts
import { AgentTruncatedError } from "@statelyai/agent";
import type { AgentRequestExecutorInfo, AgentTextRequest } from "@statelyai/agent";

function onTruncated(
  request: AgentTextRequest,
  info: AgentRequestExecutorInfo | undefined,
  cause: unknown,
  partialText?: string,
): never {
  // `request.name` is optional, and `requestName` is required. `partialOutput`
  // is set only when the provider returned some text, so the error shape
  // stays the same whether or not there was a partial answer.
  const requestName = request.name ?? "(unnamed)";
  throw new AgentTruncatedError(`Request '${requestName}' hit the output token limit.`, {
    requestName,
    requestId: info?.requestId,
    ...(partialText !== undefined ? { partialOutput: partialText } : {}),
    cause,
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
  },
};
```

Tool-bearing calls are not retried here because tools may have side effects. Use the framework's own interruption and retry facilities when available; Stately Agent forwards messages and execution to it.

## Resume events off the wire

A host that resumes a run from an HTTP request or a socket frame parses the payload at the boundary, then hands the parsed event to `runToQuiescence`:

```ts no-check
let event;
try {
  event = parseAgentEvent(machine, await request.json());
} catch (error) {
  return Response.json({ error: String(error) }, { status: 400 });
}

const result = await runToQuiescence(createAgentRuntime(machine, { store, threadId, executors }), {
  event,
});

if (result.ignored) {
  return Response.json(
    { error: `'${result.ignored.type}' does not apply right now` },
    { status: 409 },
  );
}
```

- `parseAgentEvent(machineOrSnapshot, payload)` takes `unknown` and returns the event typed as the machine's event union. Give it the machine to read the event schemas `setupAgent` registered, or any snapshot of it.
- It throws `AgentInvalidEventPayloadError` (code `invalid-event-payload`) for a payload that is not an object with a string `type`, a reserved `@agent.*` type, or fields that fail the schema. That is the 400.
- It does not ask whether the current state handles the event, and `runToQuiescence` adds no check of its own.
- An event the resumed state has no transition for is ignored: the run settles normally and `result.ignored` holds the event. Answer 409 if the client should know nothing happened.

See [Persistence](persistence.md#resume-with-an-event-off-the-wire).

## Write your own host loop

`runAgent(machine, options)` is `createAgentRuntime(machine, options)` driven by this loop:

```ts
const init = { snapshot, event: { type: "APPROVE" } };
const runtime = createAgentRuntime(machine, { executors });

let [state, effects] = await runtime.start(init);
await runtime.execute(effects);
if (init.event !== undefined && state.status === "active") {
  [state, effects] = runtime.transition(state, init.event);
  await runtime.execute(effects);
}
for (let event; (event = await runtime.nextEvent());) {
  [state, effects] = runtime.transition(state, event);
  await runtime.execute(effects);
}

const result = await runtime.finish();
```

Write the loop yourself when `runAgent` cannot express the host:

- **Non-blocking durable host.** A Durable Object woken by alarms runs one leg per wake-up and cannot await a whole run.
- **Events pushed mid-run.** A socket delivers user events while requests are in flight; pass each one to `runtime.transition` between effects.
- **Custom stop or checkpoint policy.** Persist after selected transitions, or stop before `nextEvent()` returns `undefined`.

Each operation is described in [The runtime loop](steps.md).

## Uncontrolled XState actor

`provideExecutors(machine, executors)` binds the executors onto the machine so a plain `createActor` runs it, for an application that owns the actor or embeds the agent machine in a larger XState system. See [Advanced](advanced.md).

Framework-owned concerns—storage, durable execution, retries, queues, and tool-loop interruption recovery—remain with the framework.
