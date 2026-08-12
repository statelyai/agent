---
title: Post-alpha roadmap
description: Work deliberately deferred past the 2.0 alpha, and why.
---

> **Alpha:** `@statelyai/agent` 2.0 is in alpha. APIs can change between releases; pin an exact version. Feedback: [github.com/statelyai/agent](https://github.com/statelyai/agent/issues).

This page lists what gates the 2.0 stable release, what is planned but not shipped, and what is not planned. If one of these items blocks you, open an issue.

## Road to v2 stable (gating)

v2 leaves alpha once its durable formats can be committed to. Changing a persisted format after the stable release is worse than staying in alpha longer, so these items land in order and the formats freeze last.

- Runtime semantics complete first. The durable-execution seams that are still moving settle before any freeze. These are the step request envelope, execution info, the event-log contract, and dynamic actor binding.
- Stable XState v6. The alpha pins `xstate@6.0.0-alpha.*`. The persisted snapshot format is XState's, so a stable v6 is a hard dependency. If v6 slips, v2 stays in alpha rather than freezing on an alpha format.
- Node LTS matrix. Declare and CI-test the supported active LTS versions.
- Format freeze. The durable formats freeze together, with documented versioning rules. The formats are the `AgentLogEntry` envelope, versioned by `AGENT_EVENT_SCHEMA_VERSION` and including the reserved `@agent.init` event and verification hashes, the `AgentEventLogStore` protocol, and the `AgentTraceEvent` envelope, versioned by `AGENT_TRACE_SCHEMA_VERSION`. Persisted snapshots are compaction caches and are versioned by XState.
- Upgrade tests. Fixture snapshots and traces from the frozen formats are replayed in CI against every release, so a break is caught before it ships.
- RC cycle. At least one release candidate ships with formats frozen and real hosts running against it before `2.0.0`.

## Planned

These items are not shipped yet. They are additive and wait on usage feedback.

### Not shipped

- Postgres and Redis storage adapters. Core ships the persistence contracts, an in-memory event-log store, and SQLite through `createSqliteEventLogStore` and `createSqliteSnapshotStore` from `@statelyai/agent/sqlite`. There are no Postgres or Redis packages.
- OpenTelemetry exporter. `@statelyai/agent/otel` ships `createOtelTraceHandler` for trace-to-span mapping, but no exporter and no SDK lifecycle. Bring your own provider, or build on `onTrace` with `serializeTraceEvent(event)` for JSONL-safe output.
- SSE and WebSocket transport helpers. Host your own stream over `onChunk`. An SSE example ships in `examples/sse-transport`.
- Agent-specific dynamic fan-out helper. Fan-out works today through XState `spawn(...)` or `Promise.all(...)`. Core has no higher-level helper for branch binding and progress.

### Near-term, non-gating

- Managed step-path helper. This is a collapsed driver over the [step path](steps.md) loop. It is deferred because the loop is around 15 lines of host-owned code by design.
- Idle persist and revive helper. The recipe of persisting a snapshot, returning a handle, and resuming with an event is a documented pattern that each host rewrites. See [Human in the loop](human-in-the-loop.md). A helper lands once real stores show the common shape.
- Plan executor. Multi-event commands use an explicit [decide loop](decisions.md#the-decide-loop-for-multi-event-commands) today. The executor layer that simulates a proposed plan up front and replans on divergence comes next, as a documented pattern first.
- Live-path mid-flight resume for fan-out. Event-log [replay](event-log.md) already re-derives spawned effects that are still owed. Restoring a live `runAgent` snapshot that was persisted mid-flight still drops frozen children.
- Tool-call gating, meaning an interrupt before selected tool calls. This is planned. The alpha carried it as a request metadata convention that core never acted on, so it was removed.

## Not planned

- Visualization tooling. Stately Studio and the VS Code extension handle diagramming and inspection. See [Scope](scope.md#non-goals).
