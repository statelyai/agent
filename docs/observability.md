# Observability

Use XState inspection for actor/runtime behavior and Agent traces for model-request behavior.

## Inspect a run

The package does not ship a visualizer. A run streams XState's inspection events through the `inspect` option, and the Stately inspector renders them live: the machine diagram, the active state, and every event.

```sh
pnpm add -D @statelyai/sdk
```

```ts no-check
import { createInspector } from "@statelyai/sdk/inspect";

const inspector = createInspector({ name: "Refund agent" });
await inspector.ready; // the URL is null until the relay registers the session
console.log("Open", inspector.inspectorUrl);

try {
  const result = await runAgent(machine, { input, executors, inspect: inspector.inspect });
} finally {
  inspector.destroy(); // also when runAgent throws, so the connection closes
}
```

- `inspector.inspect` is an XState `inspect` callback, so it is passed as is. `createAgentRuntime` takes the same option.
- `createInspector` connects to the hosted relay (`wss://sky.stately.ai`) unless `url` or `STATELY_INSPECT_URL` names another one.
- Create one inspector per run. Session ids are unique only within one actor system, so a reused inspector collides actor ids across runs.
- With the hosted relay, `inspectorUrl` is a one-time claim link for that session. Open it while the process runs; a new run prints a new one.
- Each actor in the run reaches the inspector once, under one handle, though the durable runtime re-creates actor objects between steps. Compare actors by `sessionId`, not by object.
- [examples/tanstack-ai-stream/inspect.ts](https://github.com/statelyai/agent/blob/next/examples/tanstack-ai-stream/inspect.ts) and [examples/next-host/agent-runtime.ts](https://github.com/statelyai/agent/blob/next/examples/next-host/agent-runtime.ts) wire it behind `STATELY_INSPECT=1`.
- `type: "choice"` states and other transient states (left at once by `always`) never appear in the viewer's snapshot sequence: they resolve within the same macrostep. `canReach` still counts them as reached.
- A `runAgent` started inside a wrapped workflow (a nested run per tool call, for example) appears in the inspector only when it gets its own `inspect` option: the workflow does not receive one, so pass the same inspector explicitly. It is a separate root actor with its own thread, and it does not resume with the outer run.

### Local relay

For a test or an offline run, start a relay in the process instead of the hosted one:

```sh
pnpm add -D @statelyai/sdk ws
```

```ts no-check
import { createInspector } from "@statelyai/sdk/inspect";
import { createNodeInspectionRelay } from "@statelyai/sdk/node-relay";

const relay = createNodeInspectionRelay({ port: 0 }); // any free port
await relay.start();
let inspector: ReturnType<typeof createInspector> | undefined;
try {
  inspector = createInspector({ url: relay.url, roomId: "local", session: "direct" });
  await inspector.ready;
  await runAgent(machine, { input, executors, inspect: inspector.inspect });
} finally {
  inspector?.destroy();
  await relay.stop();
}
```

- `@statelyai/sdk/node-relay` imports `ws`, an optional peer of `@statelyai/sdk`. Without it, the import fails with `Cannot find package 'ws'`.
- A `choice` state, or one left at once by `always`, is passed through within one step, so no snapshot shows it. Read it from `describeMachine` or `explorePaths`'s `reachedStates`.
- `session: "direct"` connects with the room id only, which is what a local relay expects.
- A test's viewer connects a WebSocket to `${relay.url}?r=<roomId>` and registers as a viewer. That is the relay endpoint, not an inspector page.

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

A `machine.transition` event carries `from.value`, the state value the event arrived in, next to `snapshot`, the state after it. The first transition of a stream (the init event, or a restore on resume) has no earlier state, so its `from.value` equals its `snapshot.value`. `traceTransitions` sets it the same way for a plain actor. When the host's own event had no transition in the active state, the runtime's `machine.transition` also carries `ignored: true` (the event `result.ignored` reports), so evals can count those events from the trace alone.

A `request.end` event carries the call's `output` and `raw`, plus what the executor reported about the call itself: `usage` when it reported tokens, and `finishReason` when it reported why the call stopped, normalized to `'stop'`, `'length'`, `'tool-calls'`, `'content-filter'`, or `'other'`. See [Finish reason and truncation](text-requests.md#finish-reason-and-truncation).

Trace handlers are observers: an `onTrace`, `onTransition`, `onChunk`, `onResult`, `onEvent`, or `on` handler that throws is reported with `console.error`, and the run continues.

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
