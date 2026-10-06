# Observability

Use XState inspection for actor/runtime behavior and Agent traces for model-request behavior.

## Trace one run

```ts no-check
await runToQuiescence(
  createAgentRuntime(machine, {
    executors,
    inspect: (event) => xstateInspector.next(event),
    onTrace: (event) => exporter.write(serializeTraceEvent(event)),
  }),
  { input },
);
```

Agent trace kinds are `run.start`, `request.start`, `request.end`, `request.error`, `stream.chunk`, `machine.transition`, `emit`, `usage.dropped`, and `run.end`.

A `request.end` event carries the call's `output` and `raw`, plus what the executor reported about the call itself: `usage` when it reported tokens, and `finishReason` when it reported why the call stopped, normalized to `'stop'`, `'length'`, `'tool-calls'`, `'content-filter'`, or `'other'`. See [Finish reason and truncation](text-requests.md#finish-reason-and-truncation).

`serializeTraceEvent` creates a JSON-safe projection. Traces are observations, not a persistence protocol; the [event log](event-log.md) is.

`usage.dropped` means the `@agent.usage` event was not delivered to the machine, because no active state accepted it or the leg had already settled. The spend is still journaled and still counted: the entry is in the event log, and `getUsageFromEvents` folds it into the totals. Only the machine event is dropped.

## Live progress

Use `onTrace` for `stream.chunk` and `machine.transition` events while the run
is active. The returned `AgentRunResult` supplies the terminal `done`, `idle`,
or `error` status. Domain failure remains part of the machine's typed output.

## State paths in logs

`getStatePath(snapshot)` renders a state value as one deterministic string, so a log line or a progress field survives nesting and parallel regions. `String(snapshot.value)` renders every non-atomic value as `[object Object]`.

```ts no-check
onTransition: (snapshot) => log.info({ state: getStatePath(snapshot) });
```

An atomic state renders as `writing`, a nested one as `review.editing.draft`, and a parallel one as `p:{left.x,right.a.b}` with its regions sorted by name.

## OpenTelemetry

Use `createOtelTraceHandler` from `@statelyai/agent/otel` as an `onTrace` sink. Framework telemetry and XState inspection remain composable with it.
