---
title: Hosts and executors
description: Give an agent machine the executor functions that call a model, and choose between the shipped AI SDK adapter or your own.
---

> **Alpha:** `@statelyai/agent` 2.0 is in alpha. APIs can change between releases; pin an exact version. Feedback: [github.com/statelyai/agent](https://github.com/statelyai/agent/issues).

## The executor contract

<!-- AgentRequestExecutors contract and bind-time checks from src/run-agent.ts -->

A **host** runs an agent machine and supplies the functions that call a model. The machine decides what to ask; the host executes it. The machine never talks to a model directly.

Those functions are the **executors** (`AgentRequestExecutors`). Each is a plain async function over a plain request object, so any SDK or a raw `fetch` can back it:

| Executor                      | Returns                                                                                                     | Required when                            |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `generateText(request, info)` | `{ output }` (text string or structured object; optional passthrough fields like `usage` allowed alongside) | machine has a generate-mode text request |
| `streamText(request, info)`   | `{ output }` (accumulated text; chunks stream through `info.onChunk`)                                       | machine has a streaming request          |
| `decide(request)`             | `{ event }` (the one event the model chose)                                                                 | machine has a decision                   |

At bind time, before any actor runs, `runAgent` checks the required executors, so a machine that needs `decide` without one fails immediately rather than mid-run. A machine with only plain actors needs no executors.

> **Note:** Mind the arity. `decide` takes one argument (the request); `generateText` and `streamText` take two (`request, info`, where `info` carries `onChunk` and the abort `signal`).

## The shipped AI SDK adapter

<!-- createAiSdkExecutors surface from src/ai-sdk/index.ts -->

`createAiSdkExecutors` from `@statelyai/agent/ai-sdk` is the only adapter this package ships. It builds the `{ generateText, streamText, decide }` set from the Vercel AI SDK (decisions map onto a tool-forced `generateText` call). The subpath exports adapters only (`defineModels`, `createAiSdkExecutors`); `runAgent` always comes from the root and always takes explicit executors.

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

Executor sets are plain objects, so mixing is fine: keep the adapter's `decide` and swap in your own `streamText`.

```ts
const executors = {
  ...createAiSdkExecutors({ models }),
  streamText: myCustomStreamText,
};
```

<!-- peer dependencies and entry points from package.json#peerDependencies and package.json#exports -->

Dependencies stay minimal:

- `ai` is an optional peer dependency, imported only by the `/ai-sdk` subpath.
- `xstate` is core's only runtime peer.
- `@opentelemetry/api` is an optional peer for the OTel bridge.
- No provider package is a dependency, because you supply the model resolver.

The package ships `@statelyai/agent`, `@statelyai/agent/ai-sdk`, `@statelyai/agent/machines`, `@statelyai/agent/otel`, `@statelyai/agent/sqlite`, and the JSON Schema at `@statelyai/agent/agent-workflow.json`. Every host helper (`getJsonSchema`, `buildEnvelopeSchema`, `parseStructuredEnvelope`, `parseOutput`, `getAgentOutputMode`, `renderDecisionAttempts`, `resolveDecision`, `executeAgentRequest`, ...) is a root export.

### Typed model aliases

Pass one `models` map to both `setupAgent` and the adapter, and request `model:` values are typed against its keys:

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

For a fully dynamic host (one whose machine must not name concrete models), use `resolveModel` instead:

- It takes the raw ref string and returns a model, so refs like `"openai/gpt-5.4-mini"` resolve without a static map.
- Pass both `models` and `resolveModel` and `resolveModel` wins.
- With `models` alone, an unknown ref throws.
- `parseModelRef(ref)` splits a `"provider/model-id"` ref, so a resolver is one line: `(ref) => openai(parseModelRef(ref).modelId)`.

Model refs are opaque strings, so any string is a legal `model:` value; the `models` map only adds key autocomplete and a resolution point.

### Multi-step tool loops

A text request runs a single model call by default. Set `metadata.maxSteps` on the request to allow a bounded tool-call loop; the adapter forwards it as `stopWhen: stepCountIs(maxSteps)`. This is adapter behavior, not core.

Request `metadata` is the host-owned per-call channel: core leaves it uninterpreted except for adapter conventions like `maxSteps`. A host that doesn't understand a key ignores it, so requests stay portable. It differs from XState `meta` (state-node/transition metadata for tooling); request `metadata` is runtime input passed to the executor. See [Text requests](text-requests.md#tools-and-multi-step-loops).

## Threading host context into actors and requests

Host-owned values (a session handle, db client, auth or billing ids) often need to reach the code that makes a model call. There is no `hostContext` option today (under consideration, **not shipped**). Pick the pattern by whether the value is serializable and whether it is needed per call:

- **Serializable ids the machine carries:** pass as machine `input`, land in `context`, map into each actor's `input`.
- **Non-serializable handles (a live session, db client, socket):** close over them where you define the actor via `.provide({ actors })` or `.withExecutor(...)`. The handle stays in the closure, never in `context` (it won't survive [snapshot serialization](human-in-the-loop.md#persist-and-resume-across-processes)).
- **Per-call reference ids** (auth token, billing id, trace id): put them in the request's input schema, so they're typed and validated at the call site rather than smuggled through `metadata`.

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

## Scripted executors (no API key)

<!-- createScriptedExecutors surface from src/scripted-executors.ts -->

`createScriptedExecutors` is the keyless executor set: a full `{ generateText, streamText, decide }` that plays back scripted answers from FIFO queues instead of calling a model. It is a root export (no dependencies), so a machine runs end to end with nothing installed but core.

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

- `decisions` answers `decide`; `text` answers every text request, `generateText` and `streamText` sharing the one queue.
- Entries are values or functions of the request — route on `request.name`, on the decision's candidate `events`, or on prior `attempts`.
- An entry may be the raw envelope (`{ output, usage }` / `{ event, usage }`), so scripted runs can exercise usage aggregation.
- A dry queue throws an error naming the pending request. Queues are copied, so one script object seeds many runs.

For a playthrough with no run loop at all, `simulateAgent` scripts the pure step path by invoke `src`. See [Testing and verification](verify.md).

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

A hand-written host reads the fields it needs off the plain request and builds its own payload. The one public mapping helper is `getJsonSchema(schema)`: it reads a Standard Schema's JSON Schema for a `response_format` or a tool's `parameters`. Wrap the declared output schema with `buildEnvelopeSchema` first (below).

Two more root exports for hand-rolled hosts:

- **`isStandardSchema(value)`** narrows an unknown schema before extraction. A tool's `inputSchema` may be an SDK-specific wrapper core can't read: check first and fall back to unconstrained parameters instead of crashing (what the shipped adapter does internally).
- **`renderDecisionAttempts(request)`** renders a decision request's prior failed `attempts` as feedback messages to append to the next call, so retries converge instead of repeating the same illegal choice. See [Decisions](decisions.md#validation-and-retries).

For runnable reference implementations against real provider SDKs (raw `openai`, raw `@anthropic-ai/sdk`, Cloudflare Workers AI, Durable Objects), see [Models and providers](models-and-providers.md).

## The structured-output envelope

<!-- buildEnvelopeSchema and the wire contract from src/text-logic.ts; adapter in src/ai-sdk -->

When a request has a structured output schema (`getAgentOutputMode(request.outputSchema) === 'structured'`), a host sends the schema wrapped as a root object (the **envelope**) and unwraps it before returning. This is THE wire contract for structured output: a root object is universally accepted as a provider response schema, unlike a bare union or array root that many providers reject.

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
  const envelope = buildEnvelopeSchema(request.outputSchema, { reasoning: request.reasoning });
  const jsonSchema = await getJsonSchema(envelope); // send this to the provider
  const parsed = parseStructuredEnvelope(request, JSON.parse(providerContent));
  return { output: parsed.result, reasoning: parsed.reasoning };
}
```

Return the **unwrapped** `.result` as `output`:

- The machine only ever validates and sees the schema it declared.
- `reasoning` is surfaced on the raw executor result only, never in machine context/output (see [reasoning opt-in](text-requests.md#reasoning)).
- Requests with no declared output schema are text requests and skip the envelope entirely.
- Prompt-serialized hosts that never send a response schema (the Workers AI host, for one) parse best-effort JSON and skip it too.

## Retries and budgets

Transport-level retries and executor-level budgets belong to the host. See [Usage and budgets](usage-and-budgets.md#retries-and-executor-budgets).

## Machines with no requests

`RunAgentOptions.getRequests` is the retrofit seam: when a machine would otherwise settle idle, this hook reads the snapshot and returns the model request(s) to run instead, so a plain invoke-less XState machine runs as an agent with no machine changes. Prompts can come from state `description`s, `meta`, tags, or a lookup keyed by state value. Full recipe in [Migrating from a loop](from-a-loop.md#retrofit-with-getrequests).

## Related

- [Models and providers](models-and-providers.md): raw SDK functions as executors, OpenAI-compatible endpoints, and reference hosts per provider.
- [Use in any stack](any-stack.md): the same machine behind an Express route, on Cloudflare, or driving itself in React.
- [Observability](observability.md): the trace stream, the observation callbacks, and exporting to OpenTelemetry.
- [Text requests](text-requests.md#reusable-request-logic-with-createtextlogic): declaring named model calls, and `createTextLogic` for standalone request logic.
- [Steps](steps.md): the lower-level per-model-call loop for durable hosts.
- [The event log](event-log.md): durability, replay, and the SQLite stores.
