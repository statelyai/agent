---
title: Post-alpha roadmap
description: Work deliberately deferred past the 2.0 alpha, and why.
---

Everything here is **additive**: none of it blocks the alpha, and all of it benefits from real usage feedback before the API shape is chosen. If you hit one of these and have opinions, open an issue; that feedback is exactly what this list is waiting on.

## Helpers (deferred until embedders show us what they actually write)

- **`stepAgent` sugar.** A collapsed `await stepAgent({ machine, state, event })` over the step loop (see [the step path](steps.md)). Deferred because the loop is ~15 lines and a collapsed helper would have to freeze plain-actor and timer semantics now. Ships if alpha users keep hand-rolling the same wrapper.
- **Idle persist/revive helper.** The persist snapshot, return pending handle, resume with event recipe (see [human in the loop](human-in-the-loop.md)) is currently a documented pattern rewritten by each host. A small helper lands once a couple of real stores (SQLite, Postgres, Redis) show the common shape.
- **Result narrowing accessor.** `result.status === 'done' ? result.output : undefined` appears at many call sites; a typed accessor could erase it.
- **`kind: 'actor'` step requests.** Plain (non-model) actors surface only in `step.actions` today (documented in [the step path](steps.md)). Promoting them to first-class step requests would make the step loop uniform; deferred until step-path hosts confirm the need.
- **Provider executor scaffolding.** Hand-rolling a raw-SDK executor is ~400 lines (see `examples/openai-sdk-host`, `examples/anthropic-sdk-host`). A `createExecutorsFromChat(...)` scaffold could cut that to ~60; deferred until a third provider example exposes the right seams. A shared `getJsonSchema(schema)` export (the `~standard.jsonSchema` extraction every adapter reimplements) rides along.
- **`ajvSchemaCompiler` export.** The Ajv `SchemaCompiler` recipe for `setupAgent.fromConfig` is ~22 lines every JSON-config user copies (see `examples/json-agent`).

## Runtime options

- **`hostContext` on `runAgent`.** Host-owned values (sessions, auth/billing ids) threaded to executors and actors without touching machine context. The documented patterns (see [host actors](host-actors.md)) cover this today via closures and input mapping; the option ships only if those prove insufficient in practice.
- **Automatic nested-machine executor binding.** `runAgent` binds the top-level machine's sources; a child machine's requests must be bound via `.provide(...)`. The alpha adds a loud bind-time error when a child request is unbound; transitive auto-binding is the follow-up.
- **Dynamic fan-out helper.** LangGraph `Send`-style declarative parallelism. Today: `Promise.all` over host actors inside one invoke (see `examples/langgraph-map-reduce`). A `fanOut(...)` helper plus per-branch progress events ships if the manual pattern proves too repetitive.

## Ecosystem

- **Storage/checkpointer adapter packages** (SQLite/Postgres/Redis) over XState persisted snapshots. Example shipped (`examples/file-snapshot-store`); packages follow demand.
- **Tracing/OTel exporter** plugging into `onResult`/`onTransition`.
- **Transport helpers.** SSE example shipped (`examples/sse-transport`); WebSocket and AI SDK UI stream variants next.
- **Host-loop signposting doc.** Three ways to drive a machine (`runAgent`, `createActor` + `waitFor`, the step loop) need a "pick by host type" guide.
- **Framework migration recipes.** Parity trackers exist (langgraph/burr/crewai); codemods only if demand shows.

## Ideas (no commitment)

See the ideas parked in the repo: trajectory/experience memory over the step envelope, and graph-based planning to goal states (plans as legal event paths). Both extend the decision primitive; neither is scheduled.
