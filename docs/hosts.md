---
title: Hosts and executors
description: Give an agent machine the executor functions that call a model, and choose between the shipped AI SDK adapter or your own.
---

> **Alpha:** `@statelyai/agent` 2.0 is in alpha. APIs can change between releases; pin an exact version. Feedback: [github.com/statelyai/agent](https://github.com/statelyai/agent/issues).

## The executor contract

<!-- AgentRequestExecutors contract and bind-time checks from src/run-agent.ts -->

A **host** runs an agent machine and supplies the functions that call a model. The machine decides what to ask; the host executes it. The machine never talks to a model directly.

Those functions are the **executors**, typed as `AgentRequestExecutors`. Each is a plain async function taking a plain request object, so any SDK or a raw `fetch` can back it:

| Executor | Returns | Required when |
| --- | --- | --- |
| `generateText(request)` | `{ output }` (text string or structured object; optional passthrough fields like `usage` allowed alongside) | machine has a generate-mode text request |
| `streamText(request, info)` | `{ output }` (accumulated text; chunks stream through `info.onChunk`) | machine has a streaming request |
| `decide(request)` | `{ event }` (the one event the model chose) | machine has a decision |

At bind time, before any actor runs, `runAgent` checks the required executors, so a machine that needs `decide` without one fails immediately rather than mid-run. A machine with only plain actors needs no executors.

> **Note:** Mind the arity. `decide` takes one argument (the request); `generateText` and `streamText` take two (`request, info`, where `info` carries `onChunk` and the abort `signal`).

## The shipped AI SDK adapter

<!-- createAiSdkExecutors surface from src/ai-sdk/index.ts -->

The one adapter this package ships is `createAiSdkExecutors` from `@statelyai/agent/ai-sdk`. It builds the `{ generateText, streamText, decide }` set from the Vercel AI SDK (decisions map onto a tool-forced `generateText` call). The subpath exports adapters only (`defineModels`, `createAiSdkExecutors`); `runAgent` always comes from core and always takes explicit executors.

```ts
import { runAgent } from "@statelyai/agent";
import { createAiSdkExecutors, defineModels } from "@statelyai/agent/ai-sdk";
import { openai } from "@ai-sdk/openai";

const models = defineModels({ quick: openai("gpt-5.4-mini") });

const result = await runAgent(machine, {
  input: { prompt: "Why state machines?" },
  executors: createAiSdkExecutors({ models }),
});
```

Executor sets are plain objects, so mixing adapters is fine: keep one adapter's `decide`, swap in another's `streamText`.

```ts
const executors = {
  ...createAiSdkExecutors({ models }),
  streamText: createOpenAiCompatExecutors({ baseUrl }).streamText,
};
```

The `ai` package is an optional peer dependency, imported only by this subpath. Core's one runtime peer is `xstate`. You supply the model resolver, so no provider package becomes a dependency either.

## Raw AI SDK functions and the OpenAI-compat adapter

The `generateText`/`streamText` executors accept the raw Vercel AI SDK functions directly, no adapter needed:

```ts
import { generateText, streamText } from "ai";

await runAgent(machine, { input, executors: { generateText, streamText } });
```

An `AgentTextRequest` is spread-compatible with the AI SDK's call options, and result shapes unwrap natively (`{ text }`; `{ textStream }`, final text via `await result.text`). Two caveats:

- **Structured output is best-effort.** A request with an `outputSchema` has its raw text `JSON.parse`d and validated; a parse failure throws. For reliable structured output use `createAiSdkExecutors` or `createOpenAiCompatExecutors`.
- **`decide` needs an adapter.** The tool-per-event mapping lives in the adapters; there is no raw AI SDK function for it.

For any OpenAI-compatible Chat Completions endpoint (Groq, Together, Ollama, vLLM, OpenRouter, LM Studio, OpenAI itself), `createOpenAiCompatExecutors({ baseUrl, apiKey?, models? })` from `@statelyai/agent/openai-compat` is a second shipped adapter: a complete `{ generateText, streamText, decide }` set over raw `fetch` with zero dependencies (pass a `fetch` override for Workers or tests).

## Typed model aliases

Prefer model aliases shared between `setupAgent` and the adapter: pass one `models` map to both, and request `model:` values are typed against its keys.

```ts
const models = defineModels({
  quick: openai("gpt-5.4-mini"),
  careful: openai("gpt-5.4"),
});

const agentSetup = setupAgent({
  models,
  context: z.object({ prompt: z.string(), answer: z.string().nullable() }),
  input: z.object({ prompt: z.string() }),
  output: answerSchema,
  requests: {
    answerQuestion: {
      schemas: { input: z.object({ prompt: z.string() }), output: answerSchema },
      model: "quick", // typed as "quick" | "careful"
      prompt: ({ input }) => input.prompt,
    },
  },
});

await runAgent(machine, { input, executors: createAiSdkExecutors({ models }) });
```

For a fully dynamic host (one whose machine must not name concrete models), use `resolveModel` instead: it takes the raw ref string and returns a model, so refs like `"openai/gpt-5.4-mini"` resolve without a static map. You can pass both; `resolveModel` wins. With `models` alone, an unknown ref throws. `parseModelRef(ref)` splits a `"provider/model-id"` ref, so a resolver is one line: `(ref) => openai(parseModelRef(ref).modelId)`. See [Which authoring form when](machines.md#which-authoring-form-when).

Model refs are opaque strings, so any string is a legal `model:` value; the `models` map only adds key autocomplete and a resolution point.

## Multi-step tool loops

A text request runs a single model call by default. Set `metadata.maxSteps` on the request to allow a bounded tool-call loop; the adapter forwards it as `stopWhen: stepCountIs(maxSteps)`. This is adapter behavior, not core.

Request `metadata` is the host-owned per-call channel: core leaves it uninterpreted except for adapter conventions like `maxSteps`. A host that doesn't understand a key ignores it, so requests stay portable. It differs from XState `meta` (state-node/transition metadata for tooling); request `metadata` is runtime input passed to the executor. See [Text requests](text-requests.md#tools-and-multi-step-loops).

## Writing your own executors

The contract is three plain functions, so a raw `fetch` is enough:

```ts
import type { AgentRequestExecutors } from "@statelyai/agent";

const executors: AgentRequestExecutors = {
  generateText: async (request) => {
    const res = await fetch("https://api.example.com/v1/generate", {
      method: "POST",
      body: JSON.stringify({ model: request.model, prompt: request.prompt }),
    });
    return { output: await res.text() };
  },
};

await runAgent(machine, { input, executors });
```

Real reference implementations against four runtimes:

| Example | Backing |
| --- | --- |
| [ai-sdk-host](../examples/ai-sdk-host/index.ts) | Vercel AI SDK, through the shipped adapter |
| [openai-sdk-host](../examples/openai-sdk-host/index.ts) | raw `openai` (Chat Completions); structured via `response_format`, decisions via `tool_choice: 'required'` |
| [anthropic-sdk-host](../examples/anthropic-sdk-host/index.ts) | raw `@anthropic-ai/sdk` (Messages); structured via forced tool call, decisions via `tool_choice: { type: 'any' }` |
| [cloudflare-agent-host](../examples/cloudflare-agent-host/index.ts), [cloudflare-workers-ai-host](../examples/cloudflare-workers-ai-host/index.ts) | Durable Object; Workers AI binding |

### Building a request payload by hand

A hand-written host reads the fields it needs off the plain request and builds its own payload; the example hosts above are the reference to copy. The one public mapping helper is `getJsonSchema(schema)` from `@statelyai/agent/adapter`: it reads a Standard Schema's JSON Schema for a `response_format` or a tool's `parameters`. Wrap the declared output schema with `buildEnvelopeSchema` first (see [the structured-output envelope](#the-structured-output-envelope)).

## The structured-output envelope

<!-- buildEnvelopeSchema and the wire contract from src/text-logic.ts; adapters in src/ai-sdk, src/openai-compat -->

When a request has a structured output schema (`getAgentOutputMode(request.outputSchema) === 'structured'`), a host sends the schema wrapped as a root object (the **envelope**) and unwraps it before returning. This is THE wire contract for structured output: a root object is universally accepted as a provider response schema, unlike a bare union or array root that many providers reject.

```json
{ "result": <the declared schema>, "reasoning": "<optional string>" }
```

```ts
import {
  buildEnvelopeSchema,
  getAgentOutputMode,
  getJsonSchema,
  parseStructuredEnvelope,
} from "@statelyai/agent/adapter";

if (getAgentOutputMode(request.outputSchema) === "structured") {
  const envelope = buildEnvelopeSchema(request.outputSchema, { reasoning: request.reasoning });
  const jsonSchema = await getJsonSchema(envelope); // send this to the provider
  const parsed = parseStructuredEnvelope(request, JSON.parse(providerContent));
  return { output: parsed.result, reasoning: parsed.reasoning };
}
```

Return the **unwrapped** `.result` as `output`: the machine only ever validates and sees the schema it declared. `reasoning` is surfaced on the raw executor result only, never in machine context/output (see [reasoning opt-in](./text-requests.md#reasoning)). The shipped adapters and the raw OpenAI/Anthropic example hosts all follow this contract. (Prompt-serialized hosts that don't send a response schema, e.g. the Workers AI host, parse best-effort JSON and skip the envelope.)

Related helpers for hand-rolled hosts and adapters, all from `@statelyai/agent/adapter`:

- **`isStandardSchema(value)`** narrows an unknown schema before extraction. A tool's `inputSchema` may be an SDK-specific wrapper core can't read: check with `isStandardSchema` and fall back to unconstrained parameters instead of crashing (what the shipped adapters do internally).
- **`renderDecisionAttempts(request)`** renders a decision request's prior failed `attempts` as feedback messages to append to the next call, so retries converge instead of repeating the same illegal choice. Both shipped adapters and all three raw-SDK example hosts use it; see [Decisions](decisions.md#validation-and-retries).
- **`matchesEventPattern(eventType, pattern)`** tests an event type against an `allowedEvents` entry: an exact type, `'*'`, or a `'prefix.*'` wildcard (`'todo.*'` matches `'todo.add'`). Useful when a host filters candidate or emitted events by pattern.

## Retries and budgets

Transport-level retries (429s, timeouts, backoff) belong in the executor or the SDK it wraps, not the machine. The AI SDK's `maxRetries` (and the OpenAI/Anthropic client equivalents) handles them; a raw-`fetch` executor adds its own loop. The machine never sees a transient network failure. Machine-level retry is different: an authored `onError` transition re-entering a state after a _semantic_ failure (a validation rejection, an exhausted decision) is control flow you model explicitly.

The built-in loop backstop is `maxModelCalls` (default 100; exceeding it settles an `error` with cause `'max-model-calls'`). For finer budgets (a token cap, a per-request-src call count), wrap the executors. A child machine's requests inherit the parent's executors, so one wrapper counts the whole tree:

```ts
function withBudget(base: AgentRequestExecutors, maxCalls: number) {
  const calls = new Map<string, number>();
  return {
    ...base,
    generateText: async (request, info) => {
      const n = (calls.get(request.src) ?? 0) + 1;
      calls.set(request.src, n);
      if (n > maxCalls) throw new Error(`Budget exceeded for '${request.src}'`);
      return base.generateText!(request, info);
    },
  };
}

await runAgent(machine, { input, executors: withBudget(executors, 20) });
```

## Observation callbacks

<!-- onTrace/onChunk/onResult/onTransition/on signatures from src/run-agent.ts -->

These `runAgent` callbacks are purely observational; they return `void` and cannot control the run:

- **`onTrace(event)`**: one ordered stream of run/request/chunk/transition/emit/end events, each stamped with `schemaVersion` (currently `1`, exported as `AGENT_TRACE_SCHEMA_VERSION`), `runId`, `seq`, `timestamp`, `machineId`, `machineVersion` (the same identity stamped onto settled snapshots as `agentMeta`). The eval trace / JSONL / telemetry-adapter slot. Uncontrolled mode gets the same stream: `provideExecutors` also accepts an `onTrace`, paired with `traceTransitions` on the actor's `inspect` to fold transitions in.
- **`onChunk(chunk, info)`**: each streamed chunk of a `mode: 'stream'` request, with the `AgentRequest` that produced it (parallel streams stay distinguishable).
- **`onResult(request, result)`**: once per resolved text or decision request (decision retries fire per attempt), with normalized `result.output` and the raw executor result. `result.raw` is whatever your executor returned verbatim: return `usage` alongside `output` and this becomes your token meter (the shipped adapter does; `raw as AiSdkGenerateResult` carries `usage`, `finishReason`, `toolCalls`, `toolResults`).
- **`onEvent(event)`**: each newly appended replayable external input, as a plain `EventObject`. Use it to persist the event log while the run is in flight; seeded resume history is not re-emitted.
- **`onTransition(snapshot, event)`**: every machine transition, with the new snapshot and causing event.
- **`on: { EVENT: handler, '*': handler }`**: events the machine emits with `enq.emit(...)`, keyed by emitted event type (`'*'` catches all).
- **`inspect(inspectionEvent)`**: raw xstate inspection passthrough for the whole actor system. `onTransition` covers the root only; to watch a child machine's states (see [multi-agent](multi-agent.md)), filter `inspectionEvent.type === '@xstate.transition'` and read `inspectionEvent.actorRef`. The `inspectTransitions(handler)` helper does that filtering and hands over the typed snapshot + actorRef.

```ts
await runAgent(machine, {
  input,
  executors,
  onTrace: (event) => jsonl.write(event),
  onChunk: (chunk, info) => process.stdout.write(chunk),
  onResult: (request, result) => log(request.id, result.raw),
  onEvent: (event) => eventLog.append(event),
  onTransition: (snapshot, event) => trace(snapshot.value, event.type),
  on: { EVALUATED: (e) => console.log(`score ${e.qualityScore}/10`) },
});
```

The three differ in level: `onTrace` is the whole ordered run ledger (evals, exports); `onTransition` reports in XState's terms (state values, events); `on` reports the domain events the machine emits at authored moments (a progress UI, an SSE stream, a log line). Declare their schemas in `setupAgent` and both `enq.emit(...)` and the `on` handlers are fully typed:

```ts
const agentSetup = setupAgent({
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

> **Note:** Tracing and OpenTelemetry are bring-your-own; no exporter ships. [Observability](observability.md) covers the versioned trace stream, watching a run in the Stately Inspector, and a copy-paste `onTrace` → OTel recipe.

## Testing with deterministic executors

<!-- withExecutor test binding from src/text-logic.ts and examples/email-drafter -->

Because executors are plain functions, a test supplies scripted ones and never touches the network. Bind them with `withExecutor`:

```ts
const machine = emailDrafter.provide({
  actors: {
    draftEmail: draftEmail.withExecutor(async ({ request }) => {
      return { output: { to: "sam@example.com", subject: "Hello", body: "Hi Sam!" } };
    }),
  },
});
```

[examples/email-drafter/index.ts](../examples/email-drafter/index.ts) drives a full run this way: fixed values, deterministic, no model called.

### Direct execution without runAgent

Calling `.withExecutor(...)` also binds execution onto one logic for normal XState use, bypassing `runAgent`'s executor slots. Provide the bound logic as an actor source and run with `createActor` directly:

```ts
import { validateSchemaSync } from "@statelyai/agent/adapter";

const executableDraftText = draftText.withExecutor(async ({ request, signal }) => {
  const result = await generateText({
    model: resolveModel(request.model),
    system: request.system,
    prompt: request.prompt ?? "",
    abortSignal: signal,
  });
  return request.outputSchema
    ? validateSchemaSync(request.outputSchema, result.text)
    : result.text;
});

createActor(
  machine.provide({ actors: { draftText: executableDraftText } }),
  { input },
).start();
```

This is the same mechanism `runAgent` uses internally to bind executors; the direct form is useful when a logic should carry its own execution wherever it's used, independent of the host loop. See [Which authoring form when](machines.md#which-authoring-form-when).

## Built-in actor sources

Named [`requests:`](text-requests.md) on `setupAgent`, executed by an adapter, are the default (above). `setupAgent` also registers built-in actor sources for ad-hoc model work: `agent.generateText`/`agent.streamText` for inline text, `agent.decide` for standalone decisions, `agent.plan` for multi-event plans, `agent.userInput` for human input.

### Inline text requests

<!-- inline agent.generateText + runAgent, from src/setup-agent.ts and src/index.ts -->

For a one-off text request, `agent.generateText` is a quick inline path (prefer named [`requests:`](text-requests.md) once a call is reused or worth testing):

```ts
import { runAgent } from "@statelyai/agent";
import { parseOutput } from "@statelyai/agent/adapter";

// ...
generating: {
  invoke: {
    id: "draft", // durable id: how a resumed/replayed run matches the invoke to its onDone
    src: "agent.generateText",
    input: ({ context }) => ({
      model: "openai/gpt-5.4-mini",
      prompt: context.prompt,
      outputSchema: resultSchema,
    }),
    onDone: ({ output }) => ({
      target: "done",
      context: { result: parseOutput(resultSchema, output) },
    }),
  },
},

// ...
await runAgent(machine, { input, executors: { generateText, streamText } }); // any SDK
```

Every agent invoke should have a durable `id`: it's how a resumed/replayed run matches the invoke back to its `onDone`. `agent.streamText` and `agent.decide` are the streaming and decision counterparts.

### Implementing agent.userInput

The `agent.userInput` builtin gathers human input mid-run without settling. It's one of two waiting styles; see [Choosing between the two waiting styles](human-in-the-loop.md#choosing-between-the-two-waiting-styles). The host owns delivery and resume. Two ways to implement it.

**`RunAgentOptions.userInput`**, the inline path:

```ts
const result = await runAgent(machine, {
  input,
  executors: { generateText },
  userInput: async (input) => showFormAndWaitForSubmit(input),
});
```

**A provided actor source**, for the step path, or when the inline path doesn't fit:

```ts
import { createAsyncLogic } from "xstate";

const boundMachine = machine.provide({
  actors: {
    "agent.userInput": createAsyncLogic({
      run: async ({ input }) => showFormAndWaitForSubmit(input),
    }),
  },
});
```

If a machine invokes `agent.userInput` and neither is supplied, `runAgent` fails at bind time, before any model call, naming the actor and recommending the idle-state pattern instead. Static [machine config](machines-as-data.md) uses the same actor source:

```yaml
invoke:
  src: agent.userInput
  input:
    prompt: "Who should receive this email?"
    schema:
      type: object
      properties:
        recipient: { type: string }
      required: [recipient]
  onDone:
    assign:
      recipient: "{{ event.output.recipient }}"
```

### Resolving decisions standalone

[`getAgentEffects`](steps.md) surfaces a decision effect whose request's `events` field holds only the events legal from the current snapshot ([`allowedEvents`](decisions.md) intersected with XState guards). Resolve it to the chosen, validated event with `resolveDecision`:

```ts
const effects = getAgentEffects(machine, snapshot, actions, { history });
const effect = effects.find((e) => e.kind === "decision");

const event = await resolveDecision(effect.request, decide);
// { type: 'ATTACK', target: 'orc' }
```

The `resolveDecision` helper retries on an unknown event type, an invalid payload, or a guard rejection; its `snapshot.can(event)` check closes the gap at apply time. See [Decisions](decisions.md#validation-and-retries).

### Threading host context into actors and requests

Agents often need host-owned values (a session handle, db client, auth or billing ids) reaching the code that makes a model call. There is no dedicated `hostContext` option today (one is under consideration but **not shipped**); which pattern to reach for depends on whether the value is serializable and needed per call:

- **Serializable ids the machine carries:** pass as machine `input`, land in `context`, map into each actor's `input`.
- **Non-serializable handles (a live session, db client, socket):** close over them where you define the actor via `.provide({ actors })` or `.withExecutor(...)`. The handle lives in the closure, never in `context` (it won't survive [snapshot serialization](human-in-the-loop.md#persist-and-resume-across-processes)).
- **Per-call reference ids** (auth token, billing id, trace id): put them in the request's input schema so they're typed and validated at the call site, not smuggled through `metadata`.

```ts
function buildMachine(session: Session, db: DbClient) {
  return baseMachine.provide({
    actors: {
      draftEmail: draftEmail.withExecutor(async ({ request }) => {
        const history = await db.loadThread(request.threadId);
        return session.prompt(request.prompt, { history });
      }),
    },
  });
}
```

## Related

- [Text requests](text-requests.md#reusable-request-logic-with-createtextlogic): declaring named model calls, and `createTextLogic` for standalone request logic.
- [The step path](steps.md): the lower-level per-model-call checkpointing loop for durable hosts.
- [Quickstart](quickstart.md): a host and a machine together end to end.
