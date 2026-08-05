---
title: Post-alpha roadmap
description: Work deliberately deferred past the 2.0 alpha, and why.
---

> **Alpha:** `@statelyai/agent` 2.0 is in alpha. APIs can change between releases; pin an exact version. Feedback: [github.com/statelyai/agent](https://github.com/statelyai/agent/issues).

What gates 2.0 stable, and what is honestly not shipped yet. Everything not listed as gating is additive and waits on real usage feedback; if one of these blocks you, open an issue.

## Road to v2 stable (gating)

v2 leaves alpha only when its durable formats can be promised. Changing a persisted format after stable is worse than staying alpha longer, so these land in order and formats freeze last.

- **Runtime semantics complete first.** The durable-execution seams still moving (step request envelope, execution info, event-log contract, dynamic actor binding) settle before any freeze.
- **Stable XState v6.** The alpha pins `xstate@6.0.0-alpha.*`. The persisted snapshot format is XState's, so a stable v6 is a hard dependency: if it slips, v2 stays alpha rather than freezing on an alpha format.
- **Node LTS matrix.** Declare and CI-test the supported active LTS versions.
- **Format freeze.** The durable formats freeze together, with documented versioning rules: the `AgentLogEntry` envelope (`AGENT_EVENT_SCHEMA_VERSION`, including the reserved `@agent.init` event and verification hashes), the `AgentEventLogStore` protocol, and the `AgentTraceEvent` envelope (`AGENT_TRACE_SCHEMA_VERSION`). Persisted snapshots are compaction caches, versioned by XState.
- **Upgrade tests.** Fixture snapshots and traces from the frozen formats, replayed in CI against every release, so a break is caught before it ships.
- **RC cycle.** At least one release candidate with formats frozen and real hosts running against it before `2.0.0`.

## Not shipped yet

- **Postgres and Redis storage adapters.** Core ships the persistence contracts, an in-memory event-log store, and SQLite (`createSqliteEventLogStore` / `createSqliteSnapshotStore` from `@statelyai/agent/sqlite`). No Postgres or Redis packages.
- **OpenTelemetry exporter.** Build your own on `onTrace`; `serializeTraceEvent(event)` gives JSONL-safe output.
- **SSE/WebSocket transport helpers.** Host your own stream over `onChunk` (an SSE example ships in `examples/sse-transport`).
- **Agent-specific dynamic fan-out helper.** Fan-out works today via XState `spawn(...)` or `Promise.all(...)`; core has no higher-level helper for branch binding and progress.
- **Visualization tooling.** Stately Studio and the VS Code extension own diagramming and inspection.

## Near-term, non-gating

- **Managed thin-loop helper.** A collapsed driver over the [step path](steps.md) loop. Deferred because the loop is ~15 lines of host-owned code by design.
- **Idle persist/revive helper.** The persist, return handle, resume-with-event recipe (see [human in the loop](human-in-the-loop.md)) is a documented pattern each host rewrites; a helper lands once real stores show the common shape.
- **Plan executor.** Multi-event commands are an explicit [decide loop](decisions.md#multi-event-commands-the-decide-loop) today; the executor layer that simulates a proposed plan up front and replans on divergence is next, as a documented pattern first.
- **Live-path mid-flight resume for fan-out.** Event-log [replay](event-log.md) already re-derives still-owed spawned effects; restoring a live `runAgent` snapshot persisted mid-flight still drops frozen children.
