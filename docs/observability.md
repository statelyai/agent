---
title: Observability
description: Watch an agent run locally in the Stately Inspector, ship its versioned trace stream to OpenTelemetry, and replay any run from the snapshot it traced.
---

> **Alpha:** `@statelyai/agent` 2.0 is in alpha. APIs can change between releases; pin an exact version. Feedback: [github.com/statelyai/agent](https://github.com/statelyai/agent/issues).

This page covers how to watch an agent run, in development and in production, and how the trace stream relates to the replayable event log.

There are two ways to observe a run.

- Locally, watch it live in the [Stately Inspector](https://stately.ai/docs/inspector). The inspector is a browser-based viewer that renders a running state machine as a diagram and highlights each state as it is entered.
- In production, ship the versioned trace stream to any [OpenTelemetry](https://opentelemetry.io) backend with the [`@statelyai/agent/otel`](#otel-export) bridge. OpenTelemetry is the vendor-neutral standard for traces. Honeycomb, Langfuse, LangSmith, Braintrust, Datadog, and Grafana all ingest it.

Neither requires a hosted platform or an installed adapter. Every trace pairs with a replayable event log and a settled snapshot, so a traced run can be reproduced and resumed.

A run produces two separate streams.

- `result.events` is the replay record. It is a versioned `AgentLogEntry[]` of machine input, effect completions and failures, externally sent events, and timer firings. Each entry carries a stable identity, an acceptance time, the machine identity and version, and verification hashes.
- `AgentTraceEvent[]` is the observational stream described on this page. It covers the request lifecycle, chunks, transitions, emissions, timestamps, and run boundaries.

Pass only `result.events` to `replay`. Trace events are not a replay record. See [The event log](event-log.md#export-events-from-runagent).

<!-- viz: run observation surfaces: runAgent emitting onTrace / onTransition / on / onEvent / inspect, and where each one feeds (OTel bridge, inspector, replay log) -->

<!-- viz: trace event sequence for one run: run.start -> request.start -> stream.chunk* -> request.end -> machine.transition -> run.end -->


## The versioned trace stream

The `onTrace` callback fires a single ordered stream of `AgentTraceEvent`s. Every event carries the same envelope:

| Field            | Meaning                                                                                                                                                                          |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`  | The `AGENT_TRACE_SCHEMA_VERSION` the event was produced with.                                                                                                                    |
| `runId`          | Scopes one run; `run_<n>` (controlled) or minted per root actor (uncontrolled).                                                                                                  |
| `seq`            | Monotonic within a `runId`, so events are re-orderable after the fact.                                                                                                           |
| `timestamp`      | ISO string, set when the event is produced.                                                                                                                                      |
| `machineId`      | The machine's `id`.                                                                                                                                                              |
| `machineVersion` | The machine's version. See the fallback order below.                                                                                                                            |

`machineVersion` is the machine's own `version` from `createMachine({ version })`. A machine that declares no version falls back to its structural hash. The same identity is stamped onto settled snapshots as `agentMeta`.

`schemaVersion` is bumped only on a breaking change to the envelope or to a payload shape, so a consumer can gate on it. It is identical across `runAgent`, `provideExecutors`, and `traceTransitions`.

The payload is a discriminated union on `type`.

| `type`               | Key fields                                              | Notes                                                                                                                                                                    |
| -------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `run.start`          | `input?`, `snapshot?`, `event?`                         | Run boundary; controlled path only.                                                                                                                                      |
| `request.start`      | `request`                                               | One per model call (text or decision).                                                                                                                                   |
| `request.end`        | `request`, `output`, `raw`, `reasoning?`, `usage?`      | `raw` is your executor's verbatim result (usage, tool calls); `reasoning` and `usage` present only when the executor surfaced them.                                      |
| `request.error`      | `request`, `error`                                      | The model call threw.                                                                                                                                                    |
| `stream.chunk`       | `request`, `chunk`                                      | Each streamed chunk of a `mode: 'stream'` request.                                                                                                                       |
| `machine.transition` | `snapshot`, `event`, `eventId?`                         | Root-machine transition. `eventId` links a logged external input to its `AgentLogEntry`; raised/internal transitions have no id.                                         |
| `emit`               | `event`                                                 | An event the machine emitted with `enq.emit(...)`; controlled path only.                                                                                                 |
| `run.end`            | `status` (`done` \| `idle` \| `error`) + variant fields | `done`: `output`, `snapshot`. `idle`: `snapshot`, `pendingUserInputs?`, `persistedSnapshot?`. `error`: `cause`, `error`, `snapshot`. Run boundary; controlled path only. |

Each `request` is an `AgentStepRequest`. A text request carries `src`, and a decision carries `model` instead. Both carry `id` and `kind`.

Two timestamps appear in the system, and neither is machine time.

- Trace `timestamp` records when an observation was emitted.
- Replay-entry `recordedAt` records when the host accepted the durable machine input.

Put time in the event payload when transition logic depends on it.

## Wiring

### Controlled (`runAgent`)

On `runAgent`, `onTrace` emits the full stream, including run boundaries.

```ts
import { runAgent, serializeTraceEvent, type AgentTraceEvent } from "@statelyai/agent";

await runAgent(machine, {
  input,
  executors,
  onTrace: (event: AgentTraceEvent) => console.log(JSON.stringify(serializeTraceEvent(event))),
});
```

`serializeTraceEvent(event)` returns a JSONL-safe plain-JSON form. It strips values that do not survive `JSON.stringify`, such as actor refs and snapshot internals. Use it for any file, queue, or wire sink. Skip it for in-process consumers that want the live objects.

### Streaming with `createAgentRun`

`createAgentRun(machine, options)` wraps `runAgent` in a handle that exposes the same trace stream as an async iterator, alongside the same `result` promise.

```ts
import { createAgentRun } from "@statelyai/agent";

const run = createAgentRun(machine, { input, executors });

for await (const event of run.events) {
  // run.start → request/chunk/transition/emit events → run.end
  send(event); // e.g. SSE, a JSONL log, a progress UI
}

const result = await run.result; // done | idle | error, exactly as runAgent
```

- The run starts immediately. It is in flight when `createAgentRun` returns, not on the first iteration.
- Events are buffered and never block. The queue is unbounded, so a slow or absent consumer applies no backpressure to the run. You can await `result` first and drain `events` afterwards.
- The iterator yields `run.end` and then finishes. It also closes if the run settles without a `run.end`, such as after a bind-time throw.
- `result` mirrors `runAgent`. It resolves to the same `done | idle | error` value and rejects only where `runAgent` rejects, on bind-time programmer errors such as a missing executor or an illegal resume event. A run-level failure resolves with `{ status: 'error' }`.
- `onTrace` still fires. Pass `options.onTrace` and it receives every event as well. The wrapper composes with your sink rather than replacing it.
- Resume behaves the same. Options pass straight through, so a persisted `snapshot` and resume `event` stream that run from its own `run.start`.

`events` has a single consumer. A second `for await` picks up only what the first has not pulled, because the two share one cursor. Breaking out early, or calling `events.return()`, stops delivery but does not cancel the run, and `result` still settles. Pass `options.signal` to abort the work itself.

### Uncontrolled (`provideExecutors` + `traceTransitions`)

On the [uncontrolled path](any-stack.md#controlled-and-uncontrolled), `onTrace` on `provideExecutors` emits the request-level events. `traceTransitions` on the actor's `inspect` folds `machine.transition` events into the same `runId` and `seq` stream.

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

This path traces less than `runAgent` does.

- There is no `run.start` or `run.end`. A `createActor` has no run boundary, so the stream starts at the first transition and never emits a settle event.
- There are no `emit` events. In this XState build, emitted events are delivered through `actor.on(...)` rather than the inspection protocol, so an `inspect` handler cannot see them. Subscribe with `actor.on('*', ...)` if you need them.
- There are no child traces. `provideExecutors` does not descend into invoked child machines, so a child with its own agent invokes needs its own `provideExecutors(...)` call and its own stream.

## Observation callbacks

`onTrace` is one of several `runAgent` callbacks. All of them are observational only. They return `void` and cannot control the run.

- `onTrace(event)` receives the versioned trace stream described above. Use it for eval traces, JSONL logs, and telemetry.
- `onChunk(chunk, info)` receives each streamed chunk of a `mode: 'stream'` request, along with the `AgentRequest` that produced it. Parallel streams stay distinguishable.
- `onResult(request, result)` fires once per resolved text or decision request, and once per attempt for decision retries. `result.output` is the normalized output and `result.raw` is the verbatim executor result. If your executor returns `usage` alongside `output`, `raw` carries it. The shipped adapter does, so `raw as AiSdkGenerateResult` carries `usage`, `finishReason`, `toolCalls`, and `toolResults`.
- `onEvent(entry)` receives each newly created versioned `AgentLogEntry` around a replayable external input. Entries are JSON-validated and carry ids, timestamps, machine identity and version, and replay hashes. Seeded resume history is not re-emitted.
- `onTransition(snapshot, event)` receives every machine transition, with the new snapshot and the causing event.
- `on: { EVENT: handler, '*': handler }` receives events the machine emits with `enq.emit(...)`, keyed by emitted event type. `'*'` catches all of them.
- `inspect(inspectionEvent)` is a raw XState inspection passthrough for the whole actor system. The [Stately Inspector](#local-inspection) attaches this way. `onTransition` covers the root machine only. To watch a child machine's states, filter for `inspectionEvent.type === '@xstate.transition'` and read `inspectionEvent.actorRef`. The `inspectTransitions(handler)` helper does that filtering and passes a typed snapshot and actorRef. See [Multi-agent composition](multi-agent.md).

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

`onEvent` is write-through observation, not transactional durability. The live XState actor has already accepted the event, and this synchronous callback cannot await an asynchronous store before the transition happens. For append-before-continue crash safety, use [the step path](steps.md#durable-append-before-continue), where the host commits each completion envelope before exposing the derived state.

`onTrace`, `onTransition`, and `on` observe at different levels.

- `onTrace` gives every event in the run, in order. Use it for evals and exports.
- `onTransition` gives XState terms: state values and events.
- `on` gives the domain events the machine emits at authored moments. Use it for a progress UI, an SSE stream, or a log line.

### Report agent progress from state

<!-- snapshot.value, state meta, getStateMeta, and RunAgentOptions.onTransition from the public XState/Agent observation APIs -->

The current machine state is already the agent's canonical progress status. Publish `snapshot.value` from `onTransition` instead of adding status calls to every request, tool, or branch—or asking the model to report what it is doing.

```ts no-check
await runAgent(machine, {
  input,
  executors,
  onTransition: (snapshot) => {
    publishStatus({
      state: snapshot.value,
      label: getStateMeta(snapshot).status,
    });
  },
});
```

`state` remains the portable, machine-readable value. A state may optionally declare schema-typed `meta.status` text for display; `getStateMeta(snapshot)` resolves the active metadata. This also works for persisted and resumed runs because progress is derived from the snapshot, not a separate status log. Preserve nested/parallel state values rather than coercing them with `String(...)`.

`snapshot.status` is different: it reports the XState actor lifecycle (`active`, `done`, `error`, or `stopped`). Use `snapshot.value` for “what is the agent doing?” See [Thinking in state machines](thinking-in-state-machines.md#status-comes-from-state).

Declare emitted schemas in `setupAgent` and both `enq.emit(...)` and the `on` handlers are fully typed.

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

Emitted events are fire-and-forget observation, not control flow. They never target states, and a run behaves identically with no handlers attached.

## Local inspection

The Stately Inspector is a live diagram view of a running machine. Connect a run to it and every transition highlights as it happens. Point a run at it through `runAgent`'s `inspect` option, using `createInspector` from [`@statelyai/sdk`](https://www.npmjs.com/package/@statelyai/sdk). `inspect` is a raw XState inspection passthrough, so it covers the whole actor system, children included.

`createInspector` does the following:

- Runs from Node and other server runtimes. No in-browser machine is required.
- Normalizes XState v5 and v6 inspection events.
- Opens the inspector UI in your browser once connected, unless you set `autoOpen: false`.

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
  inspect: inspector.inspect,
});

inspector.destroy();
```

`inspector.roomId`, `relayUrl`, and `inspectorUrl` describe the negotiated room. Let the SDK construct them instead of writing registration messages or actor identifiers by hand.

For serverless and edge runtimes such as Cloudflare Workers and Durable Objects, `@statelyai/sdk/relay` ships `createInspectionRelay`. It is a runtime-neutral relay with bounded late-join replay that a Durable Object can host directly, so per-request lifetimes and hibernation do not break the stream.

The inspector renders the running actor as the same diagram you author, so the whole flow is visible as one live machine. See [`examples/email-drafter-inspector`](../examples/email-drafter-inspector/index.ts) for a full session. That example keeps one long-lived actor instead of using the `runAgent` loop, but the inspector wiring is identical.

## OTel export

OpenTelemetry models work as **spans**, which are timed, nested units that carry attributes. An exporter ships them to your backend. `@statelyai/agent/otel` maps the trace stream onto [OpenTelemetry GenAI](https://github.com/open-telemetry/semantic-conventions-genai) spans, the standard's conventions for model calls and agent runs. To integrate, pass a `tracer` from your existing SDK setup and pass the returned handler to `onTrace`.

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

The bridge ships no exporter and owns no SDK lifecycle. `@opentelemetry/api` is an optional peer dependency, you own the `Tracer`, and your exporter decides where the spans go. Nothing else is installed at runtime.

The run span nests under whatever span is active when the run starts, so an agent run inside an HTTP handler lands in that request's trace.

### Span mapping

| Trace event          | OTel                                                                                                  |
| -------------------- | ----------------------------------------------------------------------------------------------------- |
| `run.start`          | Opens the run span: `invoke_agent <machineId>`, `INTERNAL`.                                           |
| `request.start`      | Opens a child span per model call: `chat <model>` (`CLIENT`) for text and decision requests.          |
| `request.end`        | Token usage onto the request span, status `OK`, span ends.                                            |
| `request.error`      | `recordException` + `error.type`, status `ERROR`, span ends.                                          |
| `stream.chunk`       | Counted; lands as `agent.stream_chunks` on the request span.                                          |
| `machine.transition` | Span event `agent.transition` on the run span (`agent.event_type`, `agent.state`, `agent.event_id?`). |
| `emit`               | Span event `agent.emit` on the run span.                                                              |
| `usage.dropped`      | Span event `agent.usage.dropped` with the reason and the dropped call's tokens.                       |
| `run.end`            | `agent.status` + span status (`ERROR` records the cause), run span ends.                              |

Attributes follow the [GenAI semantic conventions](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-agent-spans.md) (Development stability, tracking core semconv v1.43.0):

| Attribute                                                                                 | From                                                                                      |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `gen_ai.operation.name`                                                                   | `invoke_agent` (run), `chat` (request).                                                   |
| `gen_ai.agent.name` / `gen_ai.agent.version`                                              | `machineId` (or the `agentName` option) / `machineVersion`.                               |
| `gen_ai.request.model`                                                                    | The model ref the request targets.                                                        |
| `gen_ai.provider.name`                                                                    | The `providerName` option. Not inferable from a model ref, so unset unless you pass it.   |
| `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`                                 | `request.end`'s `usage`, when the executor reported it.                                   |
| `gen_ai.usage.reasoning.output_tokens`, `gen_ai.usage.cache_read.input_tokens`            | Same, for `reasoningTokens` / `cachedInputTokens`.                                        |
| `agent.run_id`, `agent.machine_id`, `agent.machine_version`, `agent.trace_schema_version` | The trace envelope.                                                                       |
| `agent.request_id`, `agent.request_kind`, `agent.request_src`, `agent.request_attempt`    | The request. `request_src` is absent on a decision; `request_attempt` appears on a retry. |
| `agent.seq`                                                                               | Every span event, so events stay re-orderable downstream.                                 |

- The bridge records no prompt or response bodies by default. Semconv marks message content opt-in, and bodies are large and often sensitive, so the bridge records output sizes as `agent.output_length` instead. Pass `captureContent: true` to record JSON-stringified `gen_ai.input.messages`, `gen_ai.output.messages`, and `gen_ai.system_instructions`.
- Always call `dispose()`. It ends any span still open, so a run that never emitted `run.end`, after a crash or on an uncontrolled actor, does not leak one.
- `attributes` sets the same key/value pairs on every span the bridge creates, such as deployment, tenant, or eval id.

### Uncontrolled mode

The uncontrolled path traces less than `runAgent` does, as described in [Uncontrolled](#uncontrolled-provideexecutors--tracetransitions). One of those gaps changes the span tree: with no `run.start` or `run.end`, the run span opens on the first event of a `runId` and stays open until you dispose the handler. The handler is otherwise the same.

```ts
const tracer = new NodeTracerProvider().getTracer("my-app");
const onTrace = createOtelTraceHandler({ tracer });
const bound = provideExecutors(machine, executors, { onTrace });
const actor = createActor(bound, { inspect: traceTransitions(onTrace) });

actor.subscribe({ complete: () => onTrace.dispose() });
actor.start();
```

Those run spans carry `agent.unfinished: true` and no `agent.status`, because no settle event confirmed how they ended. Use one handler per long-lived actor and dispose it when the actor stops. This keeps handler state bounded.

### Vendor endpoints

The bridge emits plain OTel spans, so a vendor is a URL and a set of headers on your own exporter. Nothing in the wiring above changes per vendor, and no vendor SDK enters your machine.

```sh
npm install @opentelemetry/sdk-trace-node @opentelemetry/exporter-trace-otlp-http
```

The wiring is the same for every vendor. Substitute the vendor's URL and headers.

```ts
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { BatchSpanProcessor, NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { createOtelTraceHandler } from "@statelyai/agent/otel";

const exporter = new OTLPTraceExporter({
  url: "https://api.smith.langchain.com/otel/v1/traces",
  headers: { "x-api-key": process.env.LANGSMITH_API_KEY! },
});
const provider = new NodeTracerProvider({ spanProcessors: [new BatchSpanProcessor(exporter)] });
const onTrace = createOtelTraceHandler({ tracer: provider.getTracer("my-app") });
```

Endpoints and header names change over time. Each vendor's linked docs page is the authority.

| Vendor     | Endpoint                                               | Headers                                                                                 | Docs                                                                                |
| ---------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| LangSmith  | `https://api.smith.langchain.com/otel/v1/traces`       | `x-api-key`, optional `Langsmith-Project`                                               | [Docs](https://docs.langchain.com/langsmith/trace-with-opentelemetry)               |
| Braintrust | `https://api.braintrust.dev/otel/v1/traces`            | `Authorization: Bearer <key>`, `x-bt-parent` (`project_name:<name>`)                    | [Docs](https://www.braintrust.dev/docs/integrations/sdk-integrations/opentelemetry) |
| Langfuse   | `https://cloud.langfuse.com/api/public/otel/v1/traces` | `Authorization: Basic <base64(publicKey:secretKey)>`, `x-langfuse-ingestion-version: 4` | [Docs](https://langfuse.com/integrations/native/opentelemetry)                      |
| Honeycomb  | `https://api.honeycomb.io/v1/traces`                   | `x-honeycomb-team` (`x-honeycomb-dataset` on Classic only)                              | [Docs](https://docs.honeycomb.io/send-data/opentelemetry/)                          |
| Datadog    | `https://otlp.datadoghq.com/v1/traces` (US1)           | `dd-api-key`                                                                            | [Docs](https://docs.datadoghq.com/opentelemetry/setup/otlp_ingest/)                 |

- Regional hosts swap the subdomain: LangSmith `eu.`/`apac.`/`aws.`, Braintrust `api-eu.`, Langfuse `us.`/`jp.`/`hipaa.` or self-hosted, Honeycomb `api.eu1.`.
- Datadog's host depends on your site, and Datadog still recommends the Agent or Collector for production traffic. Its `trace.agent.datadoghq.com` intake is proprietary, not OTLP.
- Braintrust also runs offline scoring. See [Evals](evals.md) for scoring the same runs from `runAgent`'s output and event log.

See [`examples/langsmith-otel`](../examples/langsmith-otel/index.ts) for the full runnable wiring. It uses a real OTel SDK and a real OTLP exporter, and prints the exported span tree from a keyless run.

### Model spans via AI SDK telemetry

The `request.*` events span the model call as `runAgent` sees it: one span per request, with usage on `event.raw`. For provider-level detail such as token timing and the exact request the SDK sent, the Vercel AI SDK emits its own OpenTelemetry spans when you pass `experimental_telemetry`.

`createAiSdkExecutors` does not forward `experimental_telemetry`. Wrap the adapter's `generateText` instead of replacing it: open your own span, call through to the adapter, and end the span when the call settles. The adapter keeps handling structured output, tool loops, and `decide`.

```ts
import { trace } from "@opentelemetry/api";
import { createAiSdkExecutors } from "@statelyai/agent/ai-sdk";
import { runAgent, type AgentRequestExecutors } from "@statelyai/agent";

const adapter = createAiSdkExecutors({ models });
const tracer = trace.getTracer("my-app");

const executors: AgentRequestExecutors = {
  ...adapter,
  generateText: (request, info) =>
    tracer.startActiveSpan(`model ${request.model}`, async (span) => {
      try {
        return await adapter.generateText(request, info);
      } finally {
        span.end();
      }
    }),
};

await runAgent(machine, { input, executors });
```

Any span the AI SDK emits inside the call nests under whatever span is active when the executor runs, so provider spans appear beneath both your wrapper span and the bridge's `chat` span for that request.

## Replay from a trace

The `runId` that scopes the trace stream also identifies the settled snapshot. Capture the `runId` from any trace event, store the settled snapshot under it, and resume that run later.

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
  // Key the stored snapshot by runId.
  store.set(runId, result.persistedSnapshot ?? result.snapshot);
}

// Later, with the same machine:
const resumed = await runAgent(machine, {
  snapshot: store.get(runId!),
  event: { type: "APPROVE" },
  executors,
  onTrace: (event) => console.log(JSON.stringify(serializeTraceEvent(event))),
});
```

The snapshot is stamped with the same `machineVersion` the trace carries, so a resume against a structurally changed machine is caught. Read more about resuming across processes in [Human in the loop](human-in-the-loop.md#persist-and-resume-across-processes).

## Related

- [Debugging](debugging.md): using the inspector, trace stream, and scripted reproduction to find out why an agent misbehaved.
- [Hosts](hosts.md): running a machine from a server, queue, or CLI.
- [The event log](event-log.md): the replayable `AgentLogEntry[]` that pairs with a trace.
- [Human in the loop](human-in-the-loop.md): idle settles, persisting snapshots, and resuming by snapshot.
- [Models and providers](models-and-providers.md): where executors come from, including the raw `ai` functions used above.
