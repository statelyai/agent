---
title: Observability
description: Watch an agent run locally in the Stately Inspector, ship its versioned trace stream to OpenTelemetry, and replay any run from the snapshot it traced.
---

> **Alpha:** `@statelyai/agent` 2.0 is in alpha. APIs can change between releases; pin an exact version. Feedback: [github.com/statelyai/agent](https://github.com/statelyai/agent/issues).

Two ways to observe a run:

- **Locally**, watch it live in the [Stately Inspector](https://stately.ai/docs/inspector): the machine you author renders as a diagram that lights up state by state.
- **In production**, ship the versioned trace stream to any [OpenTelemetry](https://opentelemetry.io) backend (Honeycomb, Langfuse, LangSmith, Grafana, …) with a copy-paste `onTrace` handler.

No hosted platform, no adapter to install. Every trace pairs with a replayable event log and settled snapshot, so a traced run can be reproduced and resumed.

`result.events` is the smaller replay record: a versioned `AgentLogEntry[]` containing machine input, effect completions/failures, externally sent events, and timer firings. Each entry has stable identity, acceptance time, machine identity/version, and verification hashes. `AgentTraceEvent[]` is the richer observational stream below: request lifecycle, chunks, transitions, emissions, timestamps, and run boundaries. Feed only `result.events` to `replay`; never feed it trace events. See [The event log](event-log.md#export-events-from-runagent).

## The versioned trace stream

The `onTrace` callback fires a single ordered stream of `AgentTraceEvent`s. Every event carries the same envelope:

| Field | Meaning |
| --- | --- |
| `schemaVersion` | The `AGENT_TRACE_SCHEMA_VERSION` the event was produced with. |
| `runId` | Scopes one run; `run_<n>` (controlled) or minted per root actor (uncontrolled). |
| `seq` | Monotonic within a `runId`, so events are re-orderable after the fact. |
| `timestamp` | ISO string, set when the event is produced. |
| `machineId` | The machine's `id`. |
| `machineVersion` | `machineVersion` option, else the machine's structural hash. Same identity stamped onto settled snapshots as `agentMeta`. |

The `schemaVersion` is bumped **only** on a breaking change to the envelope or any payload shape, so a consumer can gate on it. It is identical across `runAgent`, `provideExecutors`, and `traceTransitions`.

The payload is a discriminated union on `type`:

| `type` | Key fields | Notes |
| --- | --- | --- |
| `run.start` | `input?`, `snapshot?`, `event?` | Run boundary; controlled path only. |
| `request.start` | `request` | One per model call (text, decision, or plan). |
| `request.end` | `request`, `output`, `raw`, `reasoning?`, `usage?` | `raw` is your executor's verbatim result (usage, tool calls); `reasoning` and `usage` present only when the executor surfaced them. |
| `request.error` | `request`, `error` | The model call threw. |
| `stream.chunk` | `request`, `chunk` | Each streamed chunk of a `mode: 'stream'` request. |
| `machine.transition` | `snapshot`, `event`, `eventId?` | Root-machine transition. `eventId` links a logged external input to its `AgentLogEntry`; raised/internal transitions have no id. |
| `emit` | `event` | An event the machine emitted with `enq.emit(...)`; controlled path only. |
| `run.end` | `status` (`done` \| `idle` \| `error`) + variant fields | `done`: `output`, `snapshot`. `idle`: `snapshot`, `pendingUserInputs?`, `persistedSnapshot?`. `error`: `cause`, `error`, `snapshot`. Run boundary; controlled path only. |

Each `request` is an `AgentStepRequest`: text and plan requests carry `src`; a decision carries `model` instead. All three carry `id` and `kind`.

Trace `timestamp` records when an observation was emitted. Replay-entry `recordedAt` records when the host accepted the durable machine input. Neither is semantic machine time; put time in the event payload when transition logic depends on it.

## Wiring it up

### Controlled (`runAgent`)

On `runAgent`, `onTrace` emits the full stream, run boundary included:

```ts
import {
  runAgent,
  serializeTraceEvent,
  type AgentTraceEvent,
} from "@statelyai/agent";

await runAgent(machine, {
  input,
  executors,
  onTrace: (event: AgentTraceEvent) =>
    jsonl.write(JSON.stringify(serializeTraceEvent(event))),
});
```

`serializeTraceEvent(event)` returns a JSONL-safe plain-JSON form of an `AgentTraceEvent`, stripping values that don't survive `JSON.stringify` (actor refs, snapshot internals). Use it for any file, queue, or wire sink; skip it for in-process consumers that want the live objects.

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

The uncontrolled path binds the machine once, then drives it with a plain `createActor`. `provideExecutors`' `onTrace` emits the request-level events; `traceTransitions` on the actor's `inspect` folds in `machine.transition` events on the **same** `runId`/`seq` stream:

```ts
import { createActor } from "xstate";
import {
  provideExecutors,
  serializeTraceEvent,
  traceTransitions,
  type AgentTraceEvent,
} from "@statelyai/agent";

const onTrace = (event: AgentTraceEvent) =>
  jsonl.write(JSON.stringify(serializeTraceEvent(event)));

const bound = provideExecutors(machine, executors, { onTrace });
const actor = createActor(bound, { inspect: traceTransitions(onTrace) });
actor.start();
```

Two documented differences from the controlled path:

- **No `run.start` / `run.end`.** A `createActor` has no run boundary the way `runAgent` does, so the stream starts at the first transition and never emits a settle event.
- **No `emit` events.** In this XState build, emitted events are delivered through `actor.on(...)`, not the inspection protocol, so an `inspect` handler can't see them. Subscribe with `actor.on('*', ...)` if you need them.

> **Note:** `provideExecutors` does not descend into invoked child state machines. A child machine with its own agent invokes needs its own `provideExecutors(...)` call, and its own trace stream. `runAgent` rebinds children and traces them on the parent stream; the uncontrolled path does not, by design.

## Observation callbacks

`onTrace` is one of several `runAgent` callbacks. All of them are purely observational: they return `void` and cannot control the run.

- **`onTrace(event)`**: the whole ordered run ledger described above (the eval trace / JSONL / telemetry slot). Uncontrolled mode gets the same stream via `provideExecutors` + `traceTransitions`.
- **`onChunk(chunk, info)`**: each streamed chunk of a `mode: 'stream'` request, with the `AgentRequest` that produced it (parallel streams stay distinguishable).
- **`onResult(request, result)`**: once per resolved text or decision request (decision retries fire per attempt), with normalized `result.output` and the raw executor result. `result.raw` is whatever your executor returned verbatim: return `usage` alongside `output` and this becomes your token meter (the shipped adapter does; `raw as AiSdkGenerateResult` carries `usage`, `finishReason`, `toolCalls`, `toolResults`).
- **`onEvent(entry)`**: each newly created versioned `AgentLogEntry` around a replayable external input. Entries are JSON-validated and carry ids, timestamps, machine identity/version, and replay hashes; seeded resume history is not re-emitted.
- **`onTransition(snapshot, event)`**: every machine transition, with the new snapshot and causing event.
- **`on: { EVENT: handler, '*': handler }`**: events the machine emits with `enq.emit(...)`, keyed by emitted event type (`'*'` catches all).
- **`inspect(inspectionEvent)`**: raw xstate inspection passthrough for the whole actor system (also how the [Stately Inspector](#watch-it-locally) attaches). `onTransition` covers the root only; to watch a child machine's states (see [multi-agent](multi-agent.md)), filter `inspectionEvent.type === '@xstate.transition'` and read `inspectionEvent.actorRef`. The `inspectTransitions(handler)` helper does that filtering and hands over the typed snapshot + actorRef.

```ts
await runAgent(machine, {
  input,
  executors,
  onTrace: (event) => jsonl.write(JSON.stringify(serializeTraceEvent(event))),
  onChunk: (chunk, info) => process.stdout.write(chunk),
  onResult: (request, result) => log(request.id, result.raw),
  onEvent: (entry) => eventLog.append(entry),
  onTransition: (snapshot, event) => trace(snapshot.value, event.type),
  on: { EVALUATED: (e) => console.log(`score ${e.qualityScore}/10`) },
});
```

`onEvent` is write-through observation, not transactional durability: the live XState actor has already accepted the event, and this synchronous callback cannot await an asynchronous store before the transition. For append-before-continue crash safety, drive the [pure step path](steps.md#durable-append-before-continue), where the host commits each completion envelope before exposing the derived state.

`onTrace`, `onTransition`, and `on` differ in level: `onTrace` is the whole ordered run ledger (evals, exports); `onTransition` reports in XState's terms (state values, events); `on` reports the domain events the machine emits at authored moments (a progress UI, an SSE stream, a log line). Declare their schemas in `setupAgent` and both `enq.emit(...)` and the `on` handlers are fully typed:

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

## Watch it locally

Point a run at the Stately Inspector through `runAgent`'s `inspect` option (a raw XState inspection passthrough: system-wide, children included). `createInspectorServer` opens the inspector page; `createWebSocketInspector` bridges to it:

```ts
import { createInspectorServer } from "@statelyai/inspect/server";
import { createWebSocketInspector } from "@statelyai/inspect";
import { runAgent } from "@statelyai/agent";

const server = createInspectorServer({ port: 8080, url: "https://editor.stately.ai" });
const inspector = createWebSocketInspector({ url: "ws://localhost:8080" });

await runAgent(machine, {
  input,
  executors,
  inspect: inspector.inspect, // the machine lights up in the inspector
});

inspector.stop();
server.stop();
```

The inspector renders the running actor as the same diagram you author, so the whole flow is visible as one live machine. See [`examples/email-drafter-inspector`](../examples/email-drafter-inspector/index.ts) for a full session (it keeps one long-lived actor instead of the `runAgent` loop, but the wiring is identical).

## Send it to OTel

For production, map `onTrace` onto OpenTelemetry spans. This uses only the stable `@opentelemetry/api` surface and a `tracer` from **your existing SDK setup**; the library ships no exporter and owns no SDK lifecycle:

```ts
import { trace, context, SpanStatusCode, type Span } from "@opentelemetry/api";
import type { AgentTraceEvent } from "@statelyai/agent";

const tracer = trace.getTracer("statelyai-agent");
const runSpans = new Map<string, Span>();
const reqSpans = new Map<string, Span>();

const onTrace = (event: AgentTraceEvent) => {
  switch (event.type) {
    case "run.start": {
      runSpans.set(
        event.runId,
        tracer.startSpan("agent.run", {
          attributes: {
            "agent.run_id": event.runId,
            "agent.machine_id": event.machineId,
            "agent.machine_version": event.machineVersion,
          },
        }),
      );
      break;
    }
    case "request.start": {
      const req = event.request;
      const src = "src" in req ? req.src : req.model; // decisions carry `model`
      const parent = runSpans.get(event.runId);
      const ctx = parent ? trace.setSpan(context.active(), parent) : context.active();
      reqSpans.set(
        req.id,
        tracer.startSpan(`agent.request ${src}`, {
          attributes: { "agent.request_src": src, "agent.request_kind": req.kind },
        }, ctx),
      );
      break;
    }
    case "request.end": {
      const span = reqSpans.get(event.request.id);
      // Sizes, not bodies (see below): a cheap, non-sensitive signal by default.
      span?.setAttribute("agent.output_length", JSON.stringify(event.output ?? "").length);
      span?.setStatus({ code: SpanStatusCode.OK });
      span?.end();
      break;
    }
    case "request.error": {
      const span = reqSpans.get(event.request.id);
      span?.recordException(event.error);
      span?.setStatus({ code: SpanStatusCode.ERROR });
      span?.end();
      break;
    }
    case "run.end": {
      const span = runSpans.get(event.runId);
      span?.setAttribute("agent.status", event.status);
      span?.setStatus({ code: event.status === "error" ? SpanStatusCode.ERROR : SpanStatusCode.OK });
      span?.end();
      break;
    }
  }
};
```

- **No prompt or response bodies by default.** The recipe records output *sizes*, not contents, since bodies can be large and sensitive. Opt in by adding `span.setAttribute("agent.output", JSON.stringify(event.output))` (and the `request.input` on `request.start`) once you've decided that data belongs in your traces.
- **`seq` and `timestamp` make events re-orderable.** If you'd rather not hold spans open across async work, ship each event as a span *event* on the run span instead and sort by `seq` downstream.

**Bring your own exporter and backend.** Any OTLP-capable backend works: Honeycomb, Langfuse, Grafana Tempo, or LangSmith via their OTel endpoints. For LangSmith, an `OTLPTraceExporter` pointed at `https://api.smith.langchain.com/otel/v1/traces` with `x-api-key` and `Langsmith-Project` headers is the whole integration; see [`examples/langsmith-otel`](../examples/langsmith-otel/index.ts) for a runnable end-to-end wiring (env-gated so it prints the trace stream without keys).

### Model spans via AI SDK telemetry

The `request.*` events span the model call as `runAgent` sees it: one span per request, with usage on `event.raw`. For provider-level detail (token timing, the exact request the SDK sent), the Vercel AI SDK emits its own OpenTelemetry spans when you pass `experimental_telemetry`.

The shipped `createAiSdkExecutors` does **not** forward `experimental_telemetry` (request `metadata` only carries adapter conventions like `maxSteps`). Enable it by supplying the text executors yourself (the raw `ai` functions are valid executors; see [models and providers](models-and-providers.md#reusing-models-from-other-frameworks)) and keeping the adapter's `decide`:

```ts
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

Trade-off: raw `ai` executors do structured output best-effort (`JSON.parse` + validate), so keep `createAiSdkExecutors`' `generateText` for reliable structured requests and add telemetry per-request via a wrapper only where you need the provider spans. The AI SDK's spans nest under whatever span is active when the executor runs, so they slot beneath the `request.start` span from the recipe above.

## Replay what you traced

A trace names a run; a snapshot resumes it. The `runId` scoping the trace stream also identifies the settled snapshot, so pairing them is trivial: capture the `runId` off any trace event, store the settled snapshot under it, and later resume exactly what you traced.

```ts
let runId: string | undefined;
const result = await runAgent(machine, {
  input,
  executors,
  onTrace: (event) => {
    runId = event.runId;
    jsonl.write(JSON.stringify(serializeTraceEvent(event)));
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
  onTrace: (event) => jsonl.write(JSON.stringify(serializeTraceEvent(event))),
});
```

Because the snapshot is stamped with the same `machineVersion` the trace carries, a resume against a structurally changed machine is caught (see [Human in the loop](human-in-the-loop.md#persist-and-resume-across-processes)). A traced run is a reproducible run.

## Related

- [Hosts](hosts.md): running a machine from a server, queue, or CLI.
- [The event log](event-log.md): the replayable `AgentLogEntry[]` that pairs with a trace.
- [Human in the loop](human-in-the-loop.md): idle settles, persisting snapshots, and resuming by snapshot.
- [Models and providers](models-and-providers.md): where executors come from, including the raw `ai` functions used above.
