---
title: Hosts and executors
description: Give an agent machine the executor functions that call a model, and choose between the shipped AI SDK adapter or your own.
---

> **Alpha:** `@statelyai/agent` 2.0 is in alpha. APIs can change between releases; pin an exact version. Feedback: [github.com/statelyai/agent](https://github.com/statelyai/agent/issues).

This page describes the executor contract, the AI SDK adapter that ships with the package, and how to write your own executors.

## The executor contract

<!-- AgentRequestExecutors contract and bind-time checks from src/run-agent.ts -->

A **host** runs an agent machine and supplies the functions that call a model. The machine determines which request to make. The host performs the call. The machine never calls a model directly.

Those functions are the **executors**, typed as `AgentRequestExecutors`. Each executor is an async function that takes a plain request object, so you can implement one with any SDK or with `fetch`.

<!-- viz: executor boundary: machine (states, requests, decisions) -> request object -> host executors (generateText / streamText / decide) -> model provider, with the result folded back as an event -->


| Executor                      | Returns       | Required when                            |
| ----------------------------- | ------------- | ---------------------------------------- |
| `generateText(request, info)` | `{ output }`  | machine has a generate-mode text request |
| `streamText(request, info)`   | `{ output }`  | machine has a streaming request          |
| `decide(request, info)`       | `{ event }`   | machine has a decision                   |

What each return value holds:

- `generateText` returns `output` as a text string, or as a structured object when the request declares an output schema.
- `streamText` returns `output` as the accumulated text. Individual chunks are delivered through `info.onChunk` while the call runs.
- `decide` returns `event`, the one event the model chose from the candidate set.

An executor may return extra passthrough fields alongside `output` or `event`. `usage` is the common one. See [Usage and budgets](usage-and-budgets.md).

`runAgent` checks the required executors at bind time, before any actor runs. A machine that needs `decide` but has no `decide` executor fails immediately instead of failing mid-run. A machine with only plain actors needs no executors.

All three executors take the same two arguments, `request` and `info`. The `info` argument carries `onChunk`, the abort `signal`, the `runId`, the `requestId`, and the `callKey`.

### Idempotency keys

Effect execution is at-least-once. A host runs the call and then journals its completion, so a crash between the two re-executes the call when the run resumes.

`info.callKey` is the key that makes the duplicate safe to drop:

- Its format is `${logId}:${siteId}#${occurrence}`. `logId` identifies the log lineage, `siteId` the invoke site, and `occurrence` counts that site's completions in the log.
- A resumed run re-executing an in-flight call passes the same `callKey` as the original attempt.
- Each iteration of a looped state gets its own key: `ask#1`, `ask#2`, `ask#3`.
- A fork of a log keeps the parent's `logId`, so a fork can reuse results cached under the parent's keys.
- [`runDurableAgent`](choosing-a-run-mode.md) supplies the same key from its journal: the same format, the same occurrence rule, and the same key on a resume that re-executes an in-flight call.
- It is `undefined` off the `runAgent` and `runDurableAgent` paths (a bare `provideExecutors` bind) and on a run resumed from a snapshot with no event log. Neither has a log to key against.

Pass it to the provider or tool as the idempotency key, and dedupe on it in your own cache:

```ts
const results = new Map<string, { output: string }>();

const executors: AgentRequestExecutors = {
  generateText: async (request, info) => {
    const cached = info?.callKey ? results.get(info.callKey) : undefined;
    if (cached) {
      return cached;
    }
    const result = { output: await callProvider(request, info?.callKey) };
    if (info?.callKey) {
      results.set(info.callKey, result);
    }
    return result;
  },
};
```

The `${siteId}#${occurrence}` half of `callKey` is the same `requestId` the step and replay APIs put on an owed effect, so a host that mixes `runAgent` with [steps](steps.md) keys both on the same value.

## The shipped AI SDK adapter

<!-- createAiSdkExecutors surface from src/ai-sdk/index.ts -->

`createAiSdkExecutors` from `@statelyai/agent/ai-sdk` is the only adapter that ships with this package. It builds the `{ generateText, streamText, decide }` set from the Vercel AI SDK. Decisions map onto a tool-forced `generateText` call. The `/ai-sdk` subpath exports only adapters, `defineModels` and `createAiSdkExecutors`. `runAgent` is always imported from the root and always takes explicit executors.

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

Executor sets are plain objects, so you can mix them. The following example keeps the adapter's `decide` and replaces its `streamText`.

```ts
const executors = {
  ...createAiSdkExecutors({ models }),
  streamText: myCustomStreamText,
};
```

<!-- peer dependencies and entry points from package.json#peerDependencies and package.json#exports -->

The package has these dependencies:

- `ai` is an optional peer dependency. Only the `/ai-sdk` subpath imports it.
- `xstate` is the only runtime peer dependency of core.
- `@opentelemetry/api` is an optional peer dependency for the OpenTelemetry bridge.
- No provider package is a dependency, because you supply the model resolver.

The package exports `@statelyai/agent`, `@statelyai/agent/ai-sdk`, `@statelyai/agent/machines`, `@statelyai/agent/otel`, `@statelyai/agent/sqlite`, `@statelyai/agent/validate`, and the JSON Schema at `@statelyai/agent/agent-workflow.json`. Host helpers such as `getJsonSchema`, `buildEnvelopeSchema`, `parseStructuredEnvelope`, `parseOutput`, `getAgentOutputMode`, `renderDecisionAttempts`, `resolveDecision`, and `executeAgentRequest` are root exports.

### Typed model aliases

Pass the same `models` map to `setupAgent` and to the adapter. Request `model:` values are then typed against the map's keys.

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

Use `resolveModel` for a dynamic host, where the machine must not name concrete models.

- `resolveModel` takes the raw ref string and returns a model, so a ref such as `"openai/gpt-5.4-mini"` resolves without a static map.
- If you pass both `models` and `resolveModel`, `resolveModel` takes precedence.
- If you pass only `models`, an unknown ref throws.
- `parseModelRef(ref)` splits a `"provider/model-id"` ref into its parts, so a resolver can be a single expression: `(ref) => openai(parseModelRef(ref).modelId)`.

Model refs are opaque strings, so any string is a legal `model:` value. The `models` map adds key autocomplete and a resolution point.

### Per-call provider settings

<!-- model entry settings and the settings option from src/ai-sdk/index.ts -->

Some model knobs are the host's business rather than the machine's. Reasoning effort is the clearest case: one provider takes an enum, another a thinking-token budget, a third has nothing. A machine that named one would stop running everywhere.

Give the model ref a persona instead. A `models` entry can be a `{ model, settings }` pair, and `settings` accepts anything the AI SDK's call options accept, typed against the installed `ai` version.

```ts
const models = defineModels({
  quick: openai("gpt-5.4-mini"),
  deep: { model: openai("gpt-5.4"), settings: { reasoning: "xhigh" } },
});
```

The machine then picks a persona by name, which it already does, and which is already typed:

```ts no-check
requests: {
  draft: { model: "quick", schemas, prompt: ({ input }) => input.brief },
  finalReview: { model: "deep", schemas, prompt: ({ input }) => input.draft },
}
```

Swap in a host whose `models` map defines `deep` differently and every request follows, with no edit to the machine. A host that cannot honor a knob leaves it out of its own map.

For a default across every call, or for a knob that does not generalize into a persona, `createAiSdkExecutors` also takes a top-level `settings`. Pass a function to vary it per request: a text request carries `name`, its registered key, while a decision request carries `id` and no name.

```ts
const executors = createAiSdkExecutors({
  models,
  settings: { providerOptions: { openai: { store: false } } },
});
```

Settings resolve least-specific first, so each layer overrides the one before it:

1. the host's top-level `settings`
2. the model ref's own `settings`
3. what the request itself declared, such as `temperature`

Settings apply to `generateText`, `streamText`, and `decide`. `model`, the prompt fields, `tools`, and `toolChoice` are not settable in either place — those are the machine's, and a host override would contradict it. Core neither declares nor reads any of this, so a machine stays portable.

### Multi-step tool loops

A text request runs a single model call by default. Set the typed `maxSteps` field on the request to allow a bounded tool-call loop. The adapter forwards it as `stopWhen: stepCountIs(maxSteps)`. This is adapter behavior, not core behavior.

Request `metadata` is the host-owned channel for per-call values. Core does not interpret it. A host ignores keys it does not understand, so requests remain portable across hosts. Request `metadata` is not the same as XState `meta`. XState `meta` is state-node and transition metadata used by tooling. Request `metadata` is runtime input passed to the executor. See [Text requests](text-requests.md#tools-and-multi-step-loops).

## Threading host context into actors and requests

Host-owned values such as a session handle, a database client, or auth and billing ids often need to reach the code that calls the model. There is no `hostContext` option today. It is under consideration and is not shipped. Choose a pattern based on whether the value is serializable and whether it is needed per call.

- Serializable ids that the machine carries: pass them as machine `input`. They land in `context`, and you map them into each actor's `input`.
- Non-serializable handles such as a live session, a database client, or a socket: close over them where you define the actor, using `.provide({ actors })` or `.withExecutor(...)`. The handle stays in the closure and never enters `context`, because it does not survive [snapshot serialization](human-in-the-loop.md#persist-and-resume-across-processes).
- Per-call reference ids such as an auth token, a billing id, or a trace id: put them in the request's input schema. They are then typed and validated at the call site instead of being passed through `metadata`.

```ts no-check
function buildMachine(session: Session, db: DbClient) {
  return baseMachine.provide({
    actors: {
      draftEmail: draftEmail.withExecutor(async ({ request }) => {
        const history = await db.loadThread(request.threadId);
        return { output: await session.prompt(request.prompt, { history }) };
      }),
    },
  });
}
```

## Scripted executors

<!-- createScriptedExecutors surface from src/scripted-executors.ts -->

`createScriptedExecutors` returns a full `{ generateText, streamText, decide }` set that plays back scripted answers from FIFO queues instead of calling a model. It needs no API key and makes no network calls. It is a root export with no dependencies, so a machine runs end to end with only core installed.

```ts
import { createScriptedExecutors, runAgent } from "@statelyai/agent";

const result = await runAgent(moderationMachine, {
  input: { comment: "honestly this update is terrible", trust: 20 },
  executors: createScriptedExecutors({
    decisions: [{ type: "FLAG", reason: "Borderline tone." }],
    text: ["a scripted draft"],
  }),
});
```

- `decisions` answers `decide`. `text` answers every text request, and `generateText` and `streamText` share that one queue. `userInput` answers `agent.userInput` invokes.
- The returned object also carries a `userInput` handler. Pass it to `runAgent`'s `userInput` option, because `agent.userInput` is an actor source rather than an executor slot.
- An entry is a value or a function of the request. A function can route on `request.name`, on the decision's candidate `events`, or on prior `attempts`.
- An entry may be a raw envelope, `{ output, usage }` or `{ event, usage }`, so a scripted run can exercise usage aggregation.
- A guard-rejected decision consumes an entry and retries with the next one.
- An empty queue throws an error with `code: 'scripted-executors-exhausted'` that names the pending request. Queues are copied, so one script object can seed many runs.

To script a run with no run loop, use `simulateAgent`, which scripts the step path by invoke `src`. See [Testing and verification](verify.md).

## Writing your own executors

The contract is three async functions, so `fetch` is enough to implement one.

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

A hand-written host reads the fields it needs from the request and builds its own payload. The one public mapping helper is `getJsonSchema(schema)`. It reads a Standard Schema's JSON Schema for use as a `response_format` or as a tool's `parameters`. Wrap the declared output schema with `buildEnvelopeSchema` first. See [The structured-output envelope](#the-structured-output-envelope).

Two other root exports are useful for hand-written hosts:

- `isStandardSchema(value)` narrows an unknown schema before extraction. A tool's `inputSchema` may be an SDK-specific wrapper that core cannot read. Check the value first and fall back to unconstrained parameters. The shipped adapter does this internally.
- `renderDecisionAttempts(request)` renders a decision request's prior failed `attempts` as feedback messages to append to the next call, so a retry does not repeat the same illegal choice. See [Decisions](decisions.md#validation-and-retries).

For runnable reference implementations against provider SDKs, including raw `openai`, raw `@anthropic-ai/sdk`, Cloudflare Workers AI, and Durable Objects, see [Models and providers](models-and-providers.md).

## The structured-output envelope

<!-- buildEnvelopeSchema and the wire contract from src/text-logic.ts; adapter in src/ai-sdk -->

When a request has a structured output schema, meaning `getAgentOutputMode(request.outputSchema)` returns `'structured'`, the host sends the schema wrapped in a root object called the **envelope**, then unwraps the response before returning it. This is the wire contract for structured output. Providers accept a root object as a response schema, but many reject a bare union or array at the root.

<!-- viz: structured output round trip: declared schema -> buildEnvelopeSchema -> getJsonSchema -> provider -> parseStructuredEnvelope -> unwrapped .result returned as output -->


```json
{ "result": <the declared schema>, "reasoning": "<optional string>" }
```

```ts no-check
import {
  buildEnvelopeSchema,
  getAgentOutputMode,
  getJsonSchema,
  parseStructuredEnvelope,
} from "@statelyai/agent";

if (getAgentOutputMode(request.outputSchema) === "structured") {
  const envelope = buildEnvelopeSchema(request.outputSchema, {
    reasoning: request.includeReasoning,
  });
  const jsonSchema = await getJsonSchema(envelope); // send this to the provider
  const parsed = parseStructuredEnvelope(request, JSON.parse(providerContent));
  return { output: parsed.result, reasoning: parsed.reasoning };
}
```

Return the unwrapped `.result` as `output`.

- The machine validates and sees only the schema it declared.
- `reasoning` appears on the raw executor result only. It never appears in machine context or output. See [reasoning opt-in](text-requests.md#reasoning).
- A request with no declared output schema is a text request and skips the envelope.
- A prompt-serialized host that never sends a response schema, such as the Workers AI host, parses the JSON best-effort and also skips the envelope.

## Retries and budgets

The host owns transport-level retries and executor-level budgets. See [Usage and budgets](usage-and-budgets.md#retries-and-executor-budgets).

## Machines with no requests

`RunAgentOptions.getRequests` lets you run an existing XState machine as an agent without changing the machine. When the machine would otherwise settle idle, the hook reads the snapshot and returns the model requests to run instead. Prompts can come from state `description` fields, `meta`, tags, or a lookup keyed by state value. See [Migrating from a loop](from-a-loop.md#retrofit-with-getrequests).

## Related

- [Models and providers](models-and-providers.md): raw SDK functions as executors, OpenAI-compatible endpoints, and reference hosts per provider.
- [Use in any stack](any-stack.md): the same machine behind an Express route, on Cloudflare, or driving itself in React.
- [Observability](observability.md): the trace stream, the observation callbacks, and exporting to OpenTelemetry.
- [Text requests](text-requests.md#reusable-request-logic-with-createtextlogic): declaring named model calls, and `createTextLogic` for standalone request logic.
- [Steps](steps.md): the lower-level per-model-call loop for durable hosts.
- [The event log](event-log.md): durability, replay, and the SQLite stores.
