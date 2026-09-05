# Observability

Use XState inspection for actor/runtime behavior and Agent traces for model-request behavior.

## Trace one run

```ts no-check
await runAgent(machine, {
  input,
  executors,
  inspect: (event) => xstateInspector.next(event),
  onTrace: (event) => exporter.write(serializeTraceEvent(event))
});
```

Agent trace kinds are `run.start`, `request.start`, `request.end`, `request.error`, `stream.chunk`, `machine.transition`, `emit`, `usage.dropped`, and `run.end`.

`serializeTraceEvent` creates a JSON-safe projection. Traces are observations, not a persistence protocol.

## Async stream

```ts no-check
for await (const event of runAgentStream(machine, { input, executors })) {
  if (event.kind === "chunk") process.stdout.write(event.delta);
  if (event.kind === "transition") renderState(event.value);
}
```

The terminal kind is `done`, `idle`, or `error`. There is no Agent-specific failure status; domain failure is represented by the machine's typed final output.

## OpenTelemetry

Use `createOtelTraceHandler` from `@statelyai/agent/otel` as an `onTrace` sink. Framework telemetry and XState inspection remain composable with it.
