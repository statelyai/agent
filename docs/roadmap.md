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
- **Machine-as-tool helper.** `runAgent` inside a `tool({ execute })` already covers run-to-done machines in one line; a `toAiSdkTool(machine, executors)` helper would add the idle-handle persist/resume dance for pausing machines (see `examples/machine-as-tool`). Ships if embedders keep hand-rolling it.

## Runtime options

- **`hostContext` on `runAgent`.** Host-owned values (sessions, auth/billing ids) threaded to executors and actors without touching machine context. The documented patterns (see [host actors](host-actors.md)) cover this today via closures and input mapping; the option ships only if those prove insufficient in practice.
- **Automatic nested-machine executor binding.** `runAgent` binds the top-level machine's sources; a child machine's requests must be bound via `.provide(...)`. The alpha adds a loud bind-time error when a child request is unbound; transitive auto-binding is the follow-up.
- **Dynamic fan-out helper.** Declarative dynamic parallelism. Today: `Promise.all` over host actors inside one invoke (see `examples/ai-sdk-orchestrator-worker`). A `fanOut(...)` helper plus per-branch progress events ships if the manual pattern proves too repetitive.

## Ecosystem

- **Storage/checkpointer adapter packages** (SQLite/Postgres/Redis) over XState persisted snapshots. Example shipped (`examples/file-snapshot-store`); packages follow demand.
- **Tracing/OTel exporter** plugging into `onResult`/`onTransition`/`inspect`.
- **Typed system-wide `onTransition`.** `runAgent`'s `inspect` passthrough already exposes every actor's transitions with their `actorRef`; a typed sugar (`onTransition` receiving `{ actorRef, path }` for child machines too) ships if hosts keep writing the same `@xstate.transition` filter.
- **Transport helpers.** SSE example shipped (`examples/sse-transport`); WebSocket and AI SDK UI stream variants next.
- **Host-loop signposting doc.** Three ways to drive a machine (`runAgent`, `createActor` + `waitFor`, the step loop) need a "pick by host type" guide.
- **Framework migration recipes.** Parity trackers exist for selected frameworks; codemods only if demand shows.

## Next up

- **`agent.plan` + plan executor.** `decide` stays one event; `plan` returns `{ rationale, steps: [{ event, expect? }] }` (empty steps = "no action needed"). Proposed plans are validated by simulating the event path against the machine before execution; at runtime each step's actual snapshot is diffed against the simulated one, and divergence triggers a replan from the actual state under a budget. Plan executor ships as a documented pattern first (see `examples/todo-nl`, whose `applying` ceremony motivates this), then promotes to core. Full design notes: `.scratch/agent-plan.md`. Related: promoting `examples/river-crossing`'s `describeMachine` prototype to core, and a graph-search "solver mode" for pure machines via `xstate/graph`.

## Ideas (no commitment)

See the ideas parked in the repo: trajectory/experience memory over the step envelope (the world-model/ledger architecture covers this as a separate future project; keep the step envelope's per-step prediction/actual data intact so it can feed a ledger later).
