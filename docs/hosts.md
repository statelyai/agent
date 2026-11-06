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
- `requestId` is the invoke site, and `n` is the invocation's ordinal there: how many times a fold of the log has started that invoke, a cancelled invocation included. Each iteration of a looped state gets its own key, and so does a call re-entered after a cancel. A run whose log cannot be folded counts the site's completions instead, a decision counting once its chosen event is journaled.
- A call inside an invoked child machine names the child's path: `<executionId>:<childId>/<requestId>#<n>`, one `/` segment per nesting level. A `%` or `/` inside an id is escaped as `%25` or `%2F`. The child's own entries (its `actorPath`) are folded too, so `n` keeps counting across turns and across invocations of the child.
- A decision retry appends its attempt ordinal: `<executionId>:<requestId>#<n>.<attempt>`, where `attempt` is the number of prior failed attempts. Each retry is a different request, so it gets a different key.
- A [decision strategy](decisions.md#decision-strategies)'s sub-calls append their role: `<executionId>:<requestId>#<n>.<attempt>.pick`, `.group`, or `.fill`.
- A resumed run re-executing an in-flight request passes the same `callKey` as the original attempt.
- A fork mints its own lineage id (see [Fork](event-log.md#fork)), so none of its calls shares a key with its parent's.
- It is `undefined` off the `runToQuiescence` path (a bare `provideExecutors` bind) and on a run with no event log.
- Only model calls get one. A plain actor (`createAsyncLogic`, a tool) in flight at a crash runs again on resume with no key. Derive an idempotency key from the domain (an order id, a booking key) and dedupe inside the effect.

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

`decideMode` sets how a language model answers a decision: `'object'` for one structured-output object, or `'tool'` for one tool per candidate event. The default is object mode when every payload can be represented as object variants, otherwise tool mode. In tool mode, parallel tool calls are turned off with `providerOptions` (`openai.parallelToolCalls: false`, `anthropic.disableParallelToolUse: true`), merged under the host's own settings. Decision models are unaffected. See [Coercion](decisions.md#coercion).

## OpenAI SDK adapter

`@statelyai/agent/openai` maps the same three executors onto the raw `openai` package, with no AI SDK in between.

- By default, calls that carry function tools use the Responses API: `generateText` with tools, and `decide` under `decideMode: 'tool'`. Reasoning models such as `gpt-6-luna` reject function tools on Chat Completions.
- Tool-free calls use Chat Completions: `generateText` without tools, `streamText`, and `decide` in object mode.
- `api` pins every call to one API. See the table below.

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

`client` is injected, so the API key, base URL, and transport stay with the host. `openai` 5 or newer is required. It is an optional peer dependency with no version range, so an app on `openai` 4 still installs the core, and it is imported for types only. A client wrapper must forward both `responses.create` and `chat.completions.create` unless `api` pins one of them.

| `api`         | Calls with function tools | Tool-free calls and object-mode `decide` |
| ------------- | ------------------------- | ---------------------------------------- |
| unset         | `responses.create`        | `chat.completions.create`                |
| `"chat"`      | `chat.completions.create` | `chat.completions.create`                |
| `"responses"` | `responses.create`        | `responses.create`                       |

- `"chat"` is for a model or OpenAI-compatible server without `/v1/responses`. `generateText` runs its tool loop on Chat Completions, and a tool-mode decision sends `tools` with `tool_choice: 'required'`.
- `"responses"` is for a host whose recorded traffic uses the Responses API.

`resolveModel` maps a machine's model ref to a real OpenAI model id. It defaults to identity, for machines whose refs are already ids.

`settings` carries the provider knobs that belong to the host rather than the machine, such as `reasoning_effort` or `service_tier`. Key it by model ref to give a ref a persona, or pass a function of the request to vary settings per call. Settings merge under what the request declared, so a request that set `maxOutputTokens` wins. Settings use Chat Completions names. On Responses calls:

- `reasoning_effort` becomes `reasoning.effort`.
- `max_completion_tokens` becomes `max_output_tokens`.
- `verbosity` becomes `text.verbosity`.
- Settings the Responses API shares by name, such as `temperature` and `service_tier`, pass through.
- Chat-only settings, such as `seed`, `stop`, `logprobs`, and `prediction`, are dropped. This includes a request's `seed` and `stopSequences`. Each dropped key logs one `console.warn` per `createOpenAiExecutors` instance.
- `store` defaults to `false`, matching Chat Completions.
- A sampling setting the model rejects, such as `temperature` or `top_p` on a reasoning model like `gpt-6-luna`, is dropped for that model after its first 400. The call is retried without it, and one warning is logged. The rejected request still counts against an HTTP-level budget.

Structured output sends the declared schema wrapped as `{ result, reasoning? }`, as `response_format: { type: 'json_schema' }` on Chat Completions or `text.format` on the Responses API. The parsed `result` is what the machine validates.

Decisions follow `decideMode`:

- `'object'` (default for compatible object payloads): one structured-output call whose schema is the decision object, sent with `strict: false`, since the adapter validates the answer itself.
- `'tool'`: one function tool per candidate event, with `tool_choice: 'required'` and `parallel_tool_calls: false`. Function tools are sent with `strict: false`, since the Responses API defaults strict mode on and arbitrary JSON Schema may fall outside it.
- An answer the adapter cannot read as one event comes back as `rejected`, and the runtime retries it. See [Coercion](decisions.md#coercion).

`generateText` runs the tool loop host-side. Each step that comes back with function calls runs the request's tools, appends the calls and one `function_call_output` item per result, and asks again. The replay is stateless: calls go back without their item ids, and reasoning items are left out. An incomplete turn, such as one cut off at `max_output_tokens`, never runs its calls, and an incomplete decision throws instead of choosing. A `failed` response throws on both paths, with its error code and message. The request's `maxSteps` bounds the number of OpenAI calls; the default is one, so a single-step request behaves as before. A tool that throws, a call to a tool the request did not offer, and arguments that are not JSON go back to the model as error results. The loop also ends early on a tool with no `execute` — a client-side tool, whose call is handed back with `finishReason: 'tool-calls'` and the raw response. Every step's `usage` is summed onto the one result the run aggregates. `modelCalls` reports the steps, and a loop that throws after a step records them on the error, so the run's budget counts them.

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
- `decideMode` sets how a decision is answered: `'object'` (the compatible-payload default) or `'tool'`. See [Coercion](decisions.md#coercion).

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
- Decisions with compatible object payloads use one structured-output object by default; incompatible payloads default to tool mode. Under `decideMode: 'tool'` they offer one tool per candidate event, with no `execute`, so the run stops at the model's first call. The tool choice is forced where the provider supports it, and an answer with more than one call is rejected.
- System messages and the request's `system` become `systemPrompts`, since TanStack AI messages have no `system` role. Image parts become `url` or base64 `data` sources; other part types throw.
- Every result reports `usage` summed over the run's model turns, the normalized `finishReason`, and every chunk the run produced on `raw`. A provider error arrives as a `RUN_ERROR` chunk and is thrown with its `code`.

`@tanstack/ai` is an optional peer dependency. To stream a run to a `useChat` client over TanStack AI's wire protocol, see [tanstack-ai-stream](https://github.com/statelyai/agent/blob/next/examples/tanstack-ai-stream).

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
- **Events pushed mid-run with a custom loop.** A socket delivers user events while requests are in flight; hand each one to `runtime.send(event)`. Without a custom loop, `runAgent`'s [`inbox`](#runagent-inbox) does the same.
- **Custom stop or checkpoint policy.** Persist after selected transitions, or stop before `nextEvent()` returns `undefined`.

Each operation is described in [The runtime loop](steps.md).

### Host events mid-run

`runtime.send(event)` puts a host event in the run's mailbox, behind whatever already arrived. A `nextEvent()` parked on a pending request resolves with it; the loop applies it with `transition` like any other event.

```ts no-check
const runtime = createAgentRuntime(machine, { executors });
socket.on("message", (event) => runtime.send(event));
cancelButton.onclick = () => runtime.send({ type: "CANCEL" });

let [state, effects] = await runtime.start({ input });
await runtime.execute(effects);
for (let event; (event = await runtime.nextEvent());) {
  [state, effects] = runtime.transition(state, event);
  await runtime.execute(effects);
}
const result = await runtime.finish();
```

- **Ordering.** One FIFO with request completions, child messages, and timers. A send during a pending invoke is handed out by the next `nextEvent()`; the invoke keeps running unless the transition leaves its state, which aborts its `signal`.
- **Journal.** A sent event is a log entry, the same as `runAgent({ event })`. Replaying `result.events` lands on the same state.
- **Unhandled.** A sent event the state has no transition for is reported as `result.ignored`.
- **Before `start`.** Queued; the first `nextEvent()` hands it out. Returns `true`.
- **After the run stopped or the machine left `active`.** Dropped. Returns `false`.
- **After `finish`.** Throws `AgentError` `runtime-finished`.
- **Not read.** A send after `nextEvent()` returned `undefined` waits for another `nextEvent()`; `finish` drops it.

`send` is asynchronous: the machine moves when the loop's next `transition` applies the event. For a cancel that must take effect before the caller returns, call `transition` from outside the loop on the loop's own `state`:

```ts no-check
let state, effects;
[state, effects] = await runtime.start({ input });
await runtime.execute(effects);

async function cancelAll() {
  if (state.status !== "active") return;
  [state, effects] = runtime.transition(state, { type: "CANCEL" });
  await runtime.execute(effects);
}

for (let event; (event = await runtime.nextEvent());) {
  [state, effects] = runtime.transition(state, event);
  await runtime.execute(effects);
}
```

Invariants for a direct `transition`:

- **One `state`.** The loop and the out-of-band caller read and write the same variable; a stale `state` forks the run.
- **Effects executed.** Pass every returned `effects` to `execute`.
- **Active only.** No `transition` once `state.status` is not `active`.
- **Loop exits on its own.** A parked `nextEvent()` returns `undefined` once the cancel stops the in-flight work.

### Abort through the machine

`options.signal` alone is a hard stop: the run settles `{ status: "error", cause: "aborted" }` and the machine sees nothing. Add `abortWith` to let the machine handle the abort, for a `cancelled` final state, cleanup invokes, or an `afterRun` hook:

```ts no-check
const result = await runAgent(machine, {
  executors,
  input,
  signal: request.signal,
  abortWith: { event: { type: "CANCEL" }, timeout: 5_000 },
});
// result.status === "done", result.snapshot.value === "cancelled"
```

- **On abort.** `event` is sent into the run (`runtime.send`); the run continues until the machine settles.
- **Abort first.** Until the machine has applied `event`, the host's direct `transition` events are dropped, including `runAgent`'s own `event`. A signal already aborted at start therefore applies `event` before anything else.
- **Fallback.** `cause: "aborted"` as without `abortWith` when:
  - the state has no transition for `event`;
  - the loop never applies it;
  - the machine handled it but settles still `active` (an idle wait nothing will answer), immediately and without waiting for `timeout`;
  - `timeout` ms pass while the machine is still active and working.
- **Journal.** The abort event is a log entry; replay reaches the same final state.

### runAgent inbox

`runAgent` returns a promise, so a host holds no runtime to `send` into. Pass an `inbox` from `createAgentInbox` instead:

```ts no-check
const inbox = createAgentInbox<EventOf<typeof machine>>();
const run = runAgent(machine, { executors, input, inbox });
cancelButton.onclick = () => inbox.send({ type: "CANCEL" });
const result = await run;
```

- **Same as `runtime.send`.** Each `inbox.send` goes to the run's mailbox and returns the same boolean. See [Host events mid-run](#host-events-mid-run).
- **Before start.** Queued; delivered after the init event and after `runAgent`'s own `event`. Returns `true`.
- **While idle.** An inbox event resumes the run, ahead of a pending `onIdle` answer; that answer is dropped. Without `onIdle`, `runAgent` returns at the first idle.
- **Ignored.** An inbox event the state does not handle is reported as `result.ignored`. Unlike an ignored `onIdle` answer, it does not end the `onIdle` loop.
- **After `runAgent` returns.** Returns `false`.
- **One call.** An inbox serves one `runAgent` call; reusing it throws `AgentError` `inbox-in-use`.

## Uncontrolled XState actor

`provideExecutors(machine, executors)` binds the executors onto the machine so a plain `createActor` runs it, for an application that owns the actor or embeds the agent machine in a larger XState system. See [Advanced](advanced.md).

Framework-owned concerns—storage, durable execution, retries, queues, and tool-loop interruption recovery—remain with the framework.
