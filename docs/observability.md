---
title: Observability
description: Watch an agent run locally in the Stately Inspector, ship its versioned trace stream to OpenTelemetry, and replay any run from the snapshot it traced.
---

> **Alpha:** `@statelyai/agent` 2.0 is in alpha. APIs can change between releases; pin an exact version. Feedback: [github.com/statelyai/agent](https://github.com/statelyai/agent/issues).

Two ways to observe a run:

- **Locally**, watch it live in the [Stately Inspector](https://stately.ai/docs/inspector): the machine you author renders as a diagram that lights up state by state.
- **In production**, ship the versioned trace stream to any [OpenTelemetry](https://opentelemetry.io) backend (Honeycomb, Langfuse, LangSmith, Grafana, …) with a copy-paste `onTrace` handler.

No hosted platform, no adapter to install. Every trace pairs with a replayable snapshot: the same `runId` that scopes a trace also settles a JSON snapshot you can resume, so a traced run is reproducible.

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
| `request.end` | `request`, `output`, `raw`, `reasoning?` | `raw` is your executor's verbatim result (usage, tool calls); `reasoning` present only when the request opted in. |
| `request.error` | `request`, `error` | The model call threw. |
| `stream.chunk` | `request`, `chunk` | Each streamed chunk of a `mode: 'stream'` request. |
| `machine.transition` | `snapshot`, `event` | Root-machine transition (new snapshot + causing event). |
| `emit` | `event` | An event the machine emitted with `enq.emit(...)`; controlled path only. |
| `run.end` | `status` (`done` \| `idle` \| `error`) + variant fields | `done`: `output`, `snapshot`. `idle`: `snapshot`, `pendingUserInputs?`, `persistedSnapshot?`. `error`: `cause`, `error`, `snapshot`. Run boundary; controlled path only. |

Each `request` is an `AgentStepRequest`: text and plan requests carry `src`; a decision carries `model` instead. All three carry `id` and `kind`.

## Wiring it up

### Controlled (`runAgent`)

On `runAgent`, `onTrace` emits the full stream, run boundary included:

```ts
import { runAgent, type AgentTraceEvent } from "@statelyai/agent";

await runAgent(machine, {
  input,
  executors,
  onTrace: (event: AgentTraceEvent) => jsonl.write(event),
});
```

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

- **Starts immediately** — the run is in flight when `createAgentRun` returns, not on first iteration.
- **Buffered, never blocking** — events are queued unboundedly, so a slow or absent consumer never applies backpressure. Await `result` first and drain `events` after if you prefer.
- **`onTrace` still fires** — pass `options.onTrace` and it receives every event too; the iterator is additive.
- **Resumes identically** — pass a persisted `snapshot` (+ resume `event`) and it streams that run from its own `run.start`.

`events` is single-consumer. Breaking out early stops delivery but does not cancel the run (`result` still settles) — pass `options.signal` to abort.

### Uncontrolled (`provideExecutors` + `traceTransitions`)

The uncontrolled path binds the machine once, then drives it with a plain `createActor`. `provideExecutors`' `onTrace` emits the request-level events; `traceTransitions` on the actor's `inspect` folds in `machine.transition` events on the **same** `runId`/`seq` stream:

```ts
import { createActor } from "xstate";
import { provideExecutors, traceTransitions, type AgentTraceEvent } from "@statelyai/agent";

const onTrace = (event: AgentTraceEvent) => jsonl.write(event);

const bound = provideExecutors(machine, executors, { onTrace });
const actor = createActor(bound, { inspect: traceTransitions(onTrace) });
actor.start();
```

Two documented differences from the controlled path:

- **No `run.start` / `run.end`.** A `createActor` has no run boundary the way `runAgent` does, so the stream starts at the first transition and never emits a settle event.
- **No `emit` events.** In this XState build, emitted events are delivered through `actor.on(...)`, not the inspection protocol, so an `inspect` handler can't see them. Subscribe with `actor.on('*', ...)` if you need them.

> **Note:** `provideExecutors` does not descend into invoked child state machines. A child machine with its own agent invokes needs its own `provideExecutors(...)` call, and its own trace stream. `runAgent` rebinds children and traces them on the parent stream; the uncontrolled path does not, by design.

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

The shipped `createAiSdkExecutors` does **not** forward `experimental_telemetry` (request `metadata` only carries adapter conventions like `maxSteps`). Enable it by supplying the text executors yourself (the raw `ai` functions are valid executors; see [interop](interop.md#reusing-models-from-other-frameworks)) and keeping the adapter's `decide`:

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
    jsonl.write(event);
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
  onTrace: (event) => jsonl.write(event),
});
```

Because the snapshot is stamped with the same `machineVersion` the trace carries, a resume against a structurally changed machine is caught (see [Human in the loop](human-in-the-loop.md#persist-and-resume-across-processes)). A traced run is a reproducible run.

## Related

- [Hosts](hosts.md#observation-callbacks): the full set of observation callbacks (`onTrace`, `onResult`, `onTransition`, `on`, `onChunk`).
- [Human in the loop](human-in-the-loop.md): idle settles, persisting snapshots, and resuming by snapshot.
- [Interop](interop.md): where executors come from, including the raw `ai` functions used above.
