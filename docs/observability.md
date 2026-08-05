---
title: Observability
description: Watch an agent run locally in the Stately Inspector, ship its versioned trace stream to OpenTelemetry, and replay any run from the snapshot it traced.
---

> **Alpha:** `@statelyai/agent` 2.0 is in alpha. APIs can change between releases; pin an exact version. Feedback: [github.com/statelyai/agent](https://github.com/statelyai/agent/issues).

Two ways to observe a run:

- **Locally**, watch it live in the [Stately Inspector](https://stately.ai/docs/inspector), a browser-based viewer that renders a running state machine as a diagram and lights it up state by state.
- **In production**, ship the versioned trace stream to any [OpenTelemetry](https://opentelemetry.io) backend with the [`@statelyai/agent/otel`](#send-it-to-otel) bridge: one handler, GenAI-semconv spans, your exporter. OpenTelemetry is the vendor-neutral standard for traces; Honeycomb, Langfuse, LangSmith, Braintrust, Datadog, and Grafana all ingest it.

No hosted platform, no adapter to install. Every trace pairs with a replayable event log and settled snapshot, so a traced run can be reproduced and resumed.

Two streams, not one:

- **`result.events`**, the replay record: a versioned `AgentLogEntry[]` of machine input, effect completions/failures, externally sent events, and timer firings. Each entry has stable identity, acceptance time, machine identity/version, and verification hashes.
- **`AgentTraceEvent[]`**, the richer observational stream described below: request lifecycle, chunks, transitions, emissions, timestamps, run boundaries.

Feed only `result.events` to `replay`, never trace events. See [The event log](event-log.md#export-events-from-runagent).

## The versioned trace stream

The `onTrace` callback fires a single ordered stream of `AgentTraceEvent`s. Every event carries the same envelope:

| Field            | Meaning                                                                                                                                                                          |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`  | The `AGENT_TRACE_SCHEMA_VERSION` the event was produced with.                                                                                                                    |
| `runId`          | Scopes one run; `run_<n>` (controlled) or minted per root actor (uncontrolled).                                                                                                  |
| `seq`            | Monotonic within a `runId`, so events are re-orderable after the fact.                                                                                                           |
| `timestamp`      | ISO string, set when the event is produced.                                                                                                                                      |
| `machineId`      | The machine's `id`.                                                                                                                                                              |
| `machineVersion` | `machineVersion` option, else the machine's own `version` (`createMachine({ version })`), else its structural hash. Same identity stamped onto settled snapshots as `agentMeta`. |

`schemaVersion` is bumped **only** on a breaking change to the envelope or a payload shape, so a consumer can gate on it. It is identical across `runAgent`, `provideExecutors`, and `traceTransitions`.

The payload is a discriminated union on `type`:

| `type`               | Key fields                                              | Notes                                                                                                                                                                    |
| -------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `run.start`          | `input?`, `snapshot?`, `event?`                         | Run boundary; controlled path only.                                                                                                                                      |
| `request.start`      | `request`                                               | One per model call (text, decision, or plan).                                                                                                                            |
| `request.end`        | `request`, `output`, `raw`, `reasoning?`, `usage?`      | `raw` is your executor's verbatim result (usage, tool calls); `reasoning` and `usage` present only when the executor surfaced them.                                      |
| `request.error`      | `request`, `error`                                      | The model call threw.                                                                                                                                                    |
| `stream.chunk`       | `request`, `chunk`                                      | Each streamed chunk of a `mode: 'stream'` request.                                                                                                                       |
| `machine.transition` | `snapshot`, `event`, `eventId?`                         | Root-machine transition. `eventId` links a logged external input to its `AgentLogEntry`; raised/internal transitions have no id.                                         |
| `emit`               | `event`                                                 | An event the machine emitted with `enq.emit(...)`; controlled path only.                                                                                                 |
| `run.end`            | `status` (`done` \| `idle` \| `error`) + variant fields | `done`: `output`, `snapshot`. `idle`: `snapshot`, `pendingUserInputs?`, `persistedSnapshot?`. `error`: `cause`, `error`, `snapshot`. Run boundary; controlled path only. |

Each `request` is an `AgentStepRequest`: text and plan requests carry `src`; a decision carries `model` instead. All three carry `id` and `kind`.

Two timestamps, neither of them machine time:

- Trace `timestamp` records when an observation was emitted.
- Replay-entry `recordedAt` records when the host accepted the durable machine input.

Put time in the event payload when transition logic depends on it.

## Wiring

### Controlled (`runAgent`)

On `runAgent`, `onTrace` emits the full stream, run boundary included:

```ts
import { runAgent, serializeTraceEvent, type AgentTraceEvent } from "@statelyai/agent";

await runAgent(machine, {
  input,
  executors,
  onTrace: (event: AgentTraceEvent) => console.log(JSON.stringify(serializeTraceEvent(event))),
});
```

`serializeTraceEvent(event)` returns a JSONL-safe plain-JSON form, stripping values that don't survive `JSON.stringify` (actor refs, snapshot internals). Use it for any file, queue, or wire sink; skip it for in-process consumers that want the live objects.

### Streaming with `createAgentRun`

`createAgentRun(machine, options)` wraps `runAgent` in a handle that exposes the same trace stream as an async iterator, alongside the same `result` promise:

```ts
import { createAgentRun } from "@statelyai/agent";

const run = createAgentRun(machine, { input, executors });

for await (const event of run.events) {
  // run.start → request/chunk/transition/emit events → run.end
  send(event); // e.g. SSE, a JSONL log, a progress UI
}

const result = await run.result; // done | idle | error, exactly as runAgent
```

- **Starts immediately**: the run is in flight when `createAgentRun` returns, not on first iteration.
- **Buffered, never blocking**: events are queued unboundedly, so a slow or absent consumer never applies backpressure to the run. Await `result` first and drain `events` after if you prefer.
- **Completes after `run.end`**: the iterator yields `run.end`, then finishes. It also closes if the run settles without one (a bind-time throw).
- **`result` mirrors `runAgent`**: same `done | idle | error` value, and it rejects only where `runAgent` rejects (bind-time programmer errors like a missing executor or an illegal resume event). A run-level failure resolves with `{ status: 'error' }`.
- **`onTrace` still fires**: pass `options.onTrace` and it receives every event too. The wrapper composes, it does not replace your sink.
- **Resumes identically**: options pass straight through, so a persisted `snapshot` (+ resume `event`) streams that run from its own `run.start`.

`events` is single-consumer: a second `for await` picks up only what the first hasn't pulled, one shared cursor rather than a replay. Breaking out early (or calling `events.return()`) stops delivery but does **not** cancel the run (`result` still settles), so pass `options.signal` to abort the work itself.

### Uncontrolled (`provideExecutors` + `traceTransitions`)

The uncontrolled path binds the machine once, then drives it with a plain `createActor`. `provideExecutors`' `onTrace` emits the request-level events; `traceTransitions` on the actor's `inspect` folds `machine.transition` events into the **same** `runId`/`seq` stream:

```ts
import { createActor } from "xstate";
import {
  provideExecutors,
  serializeTraceEvent,
  traceTransitions,
  type AgentTraceEvent,
} from "@statelyai/agent";

const onTrace = (event: AgentTraceEvent) => console.log(JSON.stringify(serializeTraceEvent(event)));

const bound = provideExecutors(machine, executors, { onTrace });
const actor = createActor(bound, { inspect: traceTransitions(onTrace) });
actor.start();
```

Two documented differences from the controlled path:

- **No `run.start` / `run.end`.** A `createActor` has no run boundary the way `runAgent` does, so the stream starts at the first transition and never emits a settle event.
- **No `emit` events.** In this XState build, emitted events are delivered through `actor.on(...)`, not the inspection protocol, so an `inspect` handler can't see them. Subscribe with `actor.on('*', ...)` if you need them.

> **Note:** `provideExecutors` does not descend into invoked child state machines. A child machine with its own agent invokes needs its own `provideExecutors(...)` call, and its own trace stream. `runAgent` rebinds children and traces them on the parent stream; the uncontrolled path does not, by design.

## Observation callbacks

`onTrace` is one of several `runAgent` callbacks. All are purely observational: they return `void` and cannot control the run.

- **`onTrace(event)`**: the whole ordered run ledger described above (the eval trace / JSONL / telemetry slot). Uncontrolled mode gets the same stream via `provideExecutors` + `traceTransitions`.
- **`onChunk(chunk, info)`**: each streamed chunk of a `mode: 'stream'` request, with the `AgentRequest` that produced it (parallel streams stay distinguishable).
- **`onResult(request, result)`**: once per resolved text or decision request (decision retries fire per attempt), with normalized `result.output` and the verbatim executor result in `result.raw`. Return `usage` alongside `output` and `raw` becomes your token meter; the shipped adapter does, so `raw as AiSdkGenerateResult` carries `usage`, `finishReason`, `toolCalls`, `toolResults`.
- **`onEvent(entry)`**: each newly created versioned `AgentLogEntry` around a replayable external input. Entries are JSON-validated and carry ids, timestamps, machine identity/version, and replay hashes; seeded resume history is not re-emitted.
- **`onTransition(snapshot, event)`**: every machine transition, with the new snapshot and causing event.
- **`on: { EVENT: handler, '*': handler }`**: events the machine emits with `enq.emit(...)`, keyed by emitted event type (`'*'` catches all).
- **`inspect(inspectionEvent)`**: raw xstate inspection passthrough for the whole actor system (also how the [Stately Inspector](#local-inspection) attaches). `onTransition` covers the root only; to watch a child machine's states (see [multi-agent](multi-agent.md)), filter `inspectionEvent.type === '@xstate.transition'` and read `inspectionEvent.actorRef`. The `inspectTransitions(handler)` helper does that filtering and hands over the typed snapshot + actorRef.

```ts
await runAgent(machine, {
  input,
  executors,
  onTrace: (event) => console.log(JSON.stringify(serializeTraceEvent(event))),
  onChunk: (chunk, info) => process.stdout.write(chunk),
  onResult: (request, result) => log(request.id, result.raw),
  onEvent: (entry) => eventLog.append(entry),
  onTransition: (snapshot, event) => trace(snapshot.value, event.type),
  on: { EVALUATED: (e: any) => console.log(`score ${e.qualityScore}/10`) },
});
```

`onEvent` is write-through observation, not transactional durability: the live XState actor has already accepted the event, and this synchronous callback cannot await an asynchronous store before the transition. For append-before-continue crash safety, use the [pure step path](steps.md#durable-append-before-continue), where the host commits each completion envelope before exposing the derived state.

`onTrace`, `onTransition`, and `on` differ in level:

- `onTrace`: the whole ordered run ledger (evals, exports).
- `onTransition`: XState's terms (state values, events).
- `on`: the domain events the machine emits at authored moments (a progress UI, an SSE stream, a log line).

Declare emitted schemas in `setupAgent` and both `enq.emit(...)` and the `on` handlers are fully typed:

```ts no-check
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

## Local inspection

The Stately Inspector is a live diagram view of a running machine: connect a run to it and every transition highlights as it happens. Point a run at it through `runAgent`'s `inspect` option (a raw XState inspection passthrough: system-wide, children included), using `createInspector` from [`@statelyai/sdk`](https://www.npmjs.com/package/@statelyai/sdk).

`createInspector`:

- runs from Node and other server runtimes, with no in-browser machine required
- normalizes XState v5 and v6 inspection events
- opens the inspector UI in your browser once connected, unless you set `autoOpen: false`

```ts
import { createInspector } from "@statelyai/sdk";
import { runAgent } from "@statelyai/agent";

const inspector = createInspector({
  // Optional: WebSocket URL of a self-hosted inspection relay.
  // Without it, the SDK uses Stately's hosted relay.
});

await runAgent(machine, {
  input,
  executors,
  inspect: inspector.inspect, // the machine lights up in the inspector
});

inspector.destroy();
```

`inspector.roomId`, `relayUrl`, and `inspectorUrl` describe the negotiated room; let the SDK construct them instead of hand-writing registration messages or actor identifiers.

For serverless/edge runtimes (Cloudflare Workers/Durable Objects), `@statelyai/sdk/relay` ships `createInspectionRelay`, a runtime-neutral relay with bounded late-join replay that a Durable Object can host directly, so per-request lifetimes and hibernation don't break the stream.

The inspector renders the running actor as the same diagram you author, so the whole flow is visible as one live machine. See [`examples/email-drafter-inspector`](../examples/email-drafter-inspector/index.ts) for a full session (it keeps one long-lived actor instead of the `runAgent` loop, but the wiring is identical).

## Send it to OTel

OpenTelemetry models work as **spans**: timed, nested units that carry attributes, which an exporter ships to whatever backend you use. `@statelyai/agent/otel` maps the trace stream onto [OpenTelemetry GenAI](https://github.com/open-telemetry/semantic-conventions-genai) spans, the standard's conventions for model calls and agent runs. That is the whole integration: pass a `tracer` from **your existing SDK setup** and hand the handler to `onTrace`.

```sh
npm install @opentelemetry/api
```

```ts
import { trace } from "@opentelemetry/api";
import { runAgent } from "@statelyai/agent";
import { createOtelTraceHandler } from "@statelyai/agent/otel";

const onTrace = createOtelTraceHandler({
  tracer: trace.getTracer("my-app"),
  providerName: "openai", // gen_ai.provider.name, when the run targets one provider
});

try {
  await runAgent(machine, { input, executors, onTrace });
} finally {
  onTrace.dispose(); // closes any span still open
}
```

**Ships no exporter, owns no SDK lifecycle.** `@opentelemetry/api` is an optional peer dependency, the `Tracer` is yours, and where the spans go is your exporter's business. Nothing else is installed at runtime.

The run span nests under whatever span is active when the run starts, so an agent run inside an HTTP handler lands in that request's trace.

### Span mapping

| Trace event          | OTel                                                                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `run.start`          | Opens the run span: `invoke_agent <machineId>`, `INTERNAL`.                                                                                      |
| `request.start`      | Opens a child span per model call: `chat <model>` (`CLIENT`) for text and decision requests, `plan <machineId>` (`INTERNAL`) for a plan request. |
| `request.end`        | Token usage onto the request span, status `OK`, span ends.                                                                                       |
| `request.error`      | `recordException` + `error.type`, status `ERROR`, span ends.                                                                                     |
| `stream.chunk`       | Counted; lands as `agent.stream_chunks` on the request span.                                                                                     |
| `machine.transition` | Span event `agent.transition` on the run span (`agent.event_type`, `agent.state`, `agent.event_id?`).                                            |
| `emit`               | Span event `agent.emit` on the run span.                                                                                                         |
| `usage.dropped`      | Span event `agent.usage.dropped` with the reason and the dropped call's tokens.                                                                  |
| `run.end`            | `agent.status` + span status (`ERROR` records the cause), run span ends.                                                                         |

Attributes follow the [GenAI semantic conventions](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-agent-spans.md) (Development stability, tracking core semconv v1.43.0):

| Attribute                                                                                 | From                                                                                      |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `gen_ai.operation.name`                                                                   | `invoke_agent` (run), `chat` or `plan` (request).                                         |
| `gen_ai.agent.name` / `gen_ai.agent.version`                                              | `machineId` (or the `agentName` option) / `machineVersion`.                               |
| `gen_ai.request.model`                                                                    | The model ref the request targets.                                                        |
| `gen_ai.provider.name`                                                                    | The `providerName` option. Not inferable from a model ref, so unset unless you pass it.   |
| `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`                                 | `request.end`'s `usage`, when the executor reported it.                                   |
| `gen_ai.usage.reasoning.output_tokens`, `gen_ai.usage.cache_read.input_tokens`            | Same, for `reasoningTokens` / `cachedInputTokens`.                                        |
| `agent.run_id`, `agent.machine_id`, `agent.machine_version`, `agent.trace_schema_version` | The trace envelope.                                                                       |
| `agent.request_id`, `agent.request_kind`, `agent.request_src`, `agent.request_attempt`    | The request. `request_src` is absent on a decision; `request_attempt` appears on a retry. |
| `agent.seq`                                                                               | Every span event, so events stay re-orderable downstream.                                 |

- **No prompt or response bodies by default.** Semconv marks message content opt-in, and bodies are large and frequently sensitive, so the bridge records output _sizes_ (`agent.output_length`) instead. Pass `captureContent: true` for JSON-stringified `gen_ai.input.messages`, `gen_ai.output.messages`, and `gen_ai.system_instructions`.
- **`dispose()` is not optional.** It ends any span still open, which is how a run that never emitted `run.end` (a crash, an uncontrolled actor) stops leaking one.
- **`attributes`** sets the same key/values on every span the bridge creates: deployment, tenant, eval id.

### Uncontrolled mode

On the [uncontrolled path](#uncontrolled-provideexecutors--tracetransitions) there is no `run.start` / `run.end`, so the run span opens on the **first** event of a `runId` and stays open until you dispose. Same handler, same tree:

```ts
const tracer = new NodeTracerProvider().getTracer("my-app");
const onTrace = createOtelTraceHandler({ tracer });
const bound = provideExecutors(machine, executors, { onTrace });
const actor = createActor(bound, { inspect: traceTransitions(onTrace) });

actor.subscribe({ complete: () => onTrace.dispose() });
actor.start();
```

Those run spans carry `agent.unfinished: true` (no settle event ever confirmed how they ended) and no `agent.status`. One handler per long-lived actor, disposed when the actor stops, keeps handler state bounded.

### Vendor endpoints

The bridge emits plain OTel spans, so a vendor is a **URL and a set of headers** on your own exporter. Nothing in the wiring above changes per vendor, and no vendor SDK enters your machine.

```sh
npm install @opentelemetry/sdk-trace-node @opentelemetry/exporter-trace-otlp-http
```

Endpoints and header names drift, so each vendor's linked OTLP docs page is the authority.

#### LangSmith

Endpoint `https://api.smith.langchain.com/otel/v1/traces`. Headers: `x-api-key`, optional `Langsmith-Project`. Regional hosts swap the subdomain (`eu.`, `apac.`, `aws.`). [Docs](https://docs.langchain.com/langsmith/trace-with-opentelemetry)

```ts
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { BatchSpanProcessor, NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { createOtelTraceHandler } from "@statelyai/agent/otel";

const exporter = new OTLPTraceExporter({
  url: "https://api.smith.langchain.com/otel/v1/traces",
  headers: { "x-api-key": process.env.LANGSMITH_API_KEY!, "Langsmith-Project": "agent" },
});
const provider = new NodeTracerProvider({ spanProcessors: [new BatchSpanProcessor(exporter)] });
const onTrace = createOtelTraceHandler({ tracer: provider.getTracer("my-app") });
```

#### Braintrust

Endpoint `https://api.braintrust.dev/otel/v1/traces` (EU: `https://api-eu.braintrust.dev/otel/v1/traces`). Headers: `Authorization: Bearer <key>`, `x-bt-parent` as `project_id:<id>` (also accepts `project_name:<name>`). [Docs](https://www.braintrust.dev/docs/integrations/sdk-integrations/opentelemetry)

```ts
const exporter = new OTLPTraceExporter({
  url: "https://api.braintrust.dev/otel/v1/traces",
  headers: {
    Authorization: `Bearer ${process.env.BRAINTRUST_API_KEY}`,
    "x-bt-parent": "project_name:agent",
  },
});
const provider = new NodeTracerProvider({ spanProcessors: [new BatchSpanProcessor(exporter)] });
const onTrace = createOtelTraceHandler({ tracer: provider.getTracer("my-app") });
```

Braintrust also runs the offline scoring side; see [Evals](evals.md) for scoring the same runs from `runAgent`'s output and event log.

#### Langfuse

Endpoint `https://cloud.langfuse.com/api/public/otel/v1/traces` (US `us.`, JP `jp.`, HIPAA `hipaa.`, or your self-hosted host). Headers: `Authorization: Basic <base64(publicKey:secretKey)>`, plus `x-langfuse-ingestion-version: 4` for the v4 data model. [Docs](https://langfuse.com/integrations/native/opentelemetry)

```ts
const auth = Buffer.from(
  `${process.env.LANGFUSE_PUBLIC_KEY}:${process.env.LANGFUSE_SECRET_KEY}`,
).toString("base64");
const exporter = new OTLPTraceExporter({
  url: "https://cloud.langfuse.com/api/public/otel/v1/traces",
  headers: { Authorization: `Basic ${auth}`, "x-langfuse-ingestion-version": "4" },
});
const provider = new NodeTracerProvider({ spanProcessors: [new BatchSpanProcessor(exporter)] });
const onTrace = createOtelTraceHandler({ tracer: provider.getTracer("my-app") });
```

#### Honeycomb

Endpoint `https://api.honeycomb.io/v1/traces` (EU: `https://api.eu1.honeycomb.io/v1/traces`). Header: `x-honeycomb-team`. `x-honeycomb-dataset` is required only on Honeycomb Classic. [Docs](https://docs.honeycomb.io/send-data/opentelemetry/)

```ts
const exporter = new OTLPTraceExporter({
  url: "https://api.honeycomb.io/v1/traces",
  headers: { "x-honeycomb-team": process.env.HONEYCOMB_API_KEY! },
});
const provider = new NodeTracerProvider({ spanProcessors: [new BatchSpanProcessor(exporter)] });
const onTrace = createOtelTraceHandler({ tracer: provider.getTracer("my-app") });
```

#### Datadog

Datadog accepts direct OTLP intake (no Agent or Collector) over `http/protobuf` or `http/json` at the `/v1/traces` path, with the header `dd-api-key`.

- **The host depends on your Datadog site.** Read your endpoint off the [OTLP intake docs](https://docs.datadoghq.com/opentelemetry/setup/otlp_ingest/) rather than copying the URL below.
- Datadog still recommends the Agent or Collector for production traffic.
- The Agent's `trace.agent.datadoghq.com` intake is proprietary, not OTLP.

```ts
const exporter = new OTLPTraceExporter({
  url: "https://otlp.datadoghq.com/v1/traces", // US1; check your Datadog site
  headers: { "dd-api-key": process.env.DD_API_KEY! },
});
const provider = new NodeTracerProvider({ spanProcessors: [new BatchSpanProcessor(exporter)] });
const onTrace = createOtelTraceHandler({ tracer: provider.getTracer("my-app") });
```

See [`examples/langsmith-otel`](../examples/langsmith-otel/index.ts) for the full runnable wiring: real OTel SDK, real OTLP exporter, keyless run that prints the exported span tree.

### Model spans via AI SDK telemetry

The `request.*` events span the model call as `runAgent` sees it: one span per request, with usage on `event.raw`. For provider-level detail (token timing, the exact request the SDK sent), the Vercel AI SDK emits its own OpenTelemetry spans when passed `experimental_telemetry`.

`createAiSdkExecutors` does **not** forward `experimental_telemetry` (request `metadata` only carries adapter conventions like `maxSteps`). Enable it by supplying the text executors yourself (the raw `ai` functions are valid executors; see [models and providers](models-and-providers.md#reusing-models-from-other-frameworks)) and keeping the adapter's `decide`:

```ts no-check
import { generateText, streamText } from "ai";
import { createAiSdkExecutors } from "@statelyai/agent/ai-sdk";

const telemetry = { isEnabled: true, functionId: "agent" } as const;

const executors = {
  ...createAiSdkExecutors({ models }), // keeps decide (and structured output)
  generateText: (request, info) =>
    generateText({
      model: resolveModel(request.model),
      system: request.system,
      prompt: request.prompt ?? "",
      abortSignal: info?.signal,
      experimental_telemetry: telemetry,
    }),
};

await runAgent(machine, { input, executors });
```

Trade-off: raw `ai` executors do structured output best-effort (`JSON.parse` + validate), so keep `createAiSdkExecutors`' `generateText` for reliable structured requests and add telemetry per-request via a wrapper only where you need the provider spans. The AI SDK's spans nest under whatever span is active when the executor runs, so they slot beneath the bridge's `chat` span for that request.

## Replay from a trace

A trace names a run; a snapshot resumes it. The `runId` scoping the trace stream also identifies the settled snapshot: capture the `runId` off any trace event, store the settled snapshot under it, and later resume exactly what you traced.

```ts
let runId: string | undefined;
const result = await runAgent(machine, {
  input,
  executors,
  onTrace: (event) => {
    runId = event.runId;
    console.log(JSON.stringify(serializeTraceEvent(event)));
  },
});

if (result.status === "idle" && runId) {
  // Persist keyed by the run's identity; resume it later, event and all.
  store.set(runId, persistSnapshot(result.persistedSnapshot ?? result.snapshot));
}

// Later, same machine and same trace lineage:
const resumed = await runAgent(machine, {
  snapshot: store.get(runId!),
  event: { type: "APPROVE" },
  executors,
  onTrace: (event) => console.log(JSON.stringify(serializeTraceEvent(event))),
});
```

Because the snapshot is stamped with the same `machineVersion` the trace carries, a resume against a structurally changed machine is caught (see [Human in the loop](human-in-the-loop.md#persist-and-resume-across-processes)). A traced run is a reproducible run.

## Related

- [Debugging](debugging.md): using the inspector, trace stream, and scripted reproduction to find out why an agent misbehaved.
- [Hosts](hosts.md): running a machine from a server, queue, or CLI.
- [The event log](event-log.md): the replayable `AgentLogEntry[]` that pairs with a trace.
- [Human in the loop](human-in-the-loop.md): idle settles, persisting snapshots, and resuming by snapshot.
- [Models and providers](models-and-providers.md): where executors come from, including the raw `ai` functions used above.
