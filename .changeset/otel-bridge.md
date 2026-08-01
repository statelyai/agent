---
"@statelyai/agent": minor
---

Added `@statelyai/agent/otel`: `createOtelTraceHandler({ tracer })` maps the versioned `AgentTraceEvent` stream onto OpenTelemetry GenAI-semconv spans, so any OTLP-ingesting backend (Braintrust, Langfuse, LangSmith, Honeycomb, Datadog, Grafana Tempo) is an endpoint + headers away.

- One `invoke_agent` span per run, one child `chat`/`plan` span per model call, transitions/emissions/dropped usage as span events.
- `gen_ai.*` attributes: operation name, request model, provider name, agent name/version, token usage.
- Prompt and output bodies are **off by default** (semconv marks message content opt-in); pass `captureContent: true` for `gen_ai.input.messages` / `gen_ai.output.messages`.
- Ships no exporter and owns no SDK lifecycle: `@opentelemetry/api` is an optional peer dependency and you bring the `Tracer`.
- Works on both paths. `runAgent`'s `onTrace` gives the full run boundary; on the uncontrolled `provideExecutors` + `traceTransitions` path the run span opens on the first event and closes on `handler.dispose()`.
