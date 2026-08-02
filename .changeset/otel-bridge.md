---
"@statelyai/agent": minor
---

**New `@statelyai/agent/otel`: agent traces as OpenTelemetry GenAI spans.** `createOtelTraceHandler` maps the versioned `AgentTraceEvent` stream onto GenAI-semconv spans, so any OTLP-ingesting backend (Braintrust, Langfuse, LangSmith, Honeycomb, Datadog, Grafana Tempo) is an endpoint and headers away.

```ts
import { createOtelTraceHandler } from "@statelyai/agent/otel";

const onTrace = createOtelTraceHandler({ tracer, providerName: "openai" });
const result = await runAgent(machine, { input, executors, onTrace });
onTrace.dispose(); // required on the uncontrolled path, where no run.end arrives
```

- One `invoke_agent` span per run, one child `chat`/`plan` span per model call, transitions/emissions/dropped usage as span events.
- `gen_ai.*` attributes: operation name, request model, provider name, agent name/version, token usage. Pass `tracer` **or** `tracerProvider`; set `providerName` yourself, since the trace stream carries only a model ref and the bridge cannot infer it. `agentName` defaults to the machine's `id`, and `attributes` adds your own to every span.
- Prompt and output bodies are **off by default** (semconv marks message content opt-in); pass `captureContent: true` for `gen_ai.input.messages` / `gen_ai.output.messages`. Sizes are always recorded.
- Ships no exporter and owns no SDK lifecycle: `@opentelemetry/api` is an optional peer dependency and you bring the `Tracer`.
- Works on both paths. `runAgent`'s `onTrace` gives the full run boundary; on the uncontrolled `provideExecutors` + `traceTransitions` path the run span opens on the first event and closes on `dispose()`.
