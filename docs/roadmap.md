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
- **Provider executor scaffolding.** Hand-rolling a raw-SDK executor is ~400 lines (see `examples/openai-sdk-host`, `examples/anthropic-sdk-host`). A `createExecutorsFromChat(...)` scaffold could cut that to ~60; deferred until a third provider example exposes the right seams. (`getJsonSchema` itself shipped; the scaffold would build on it.)
- **Schema compiler recipes.** Keep core zero-dependency and avoid blessing one JSON Schema engine in the main package. If JSON-config users keep copying the Ajv adapter, add cookbook snippets or optional adapter packages outside core.
- **Machine-as-tool helper.** `runAgent` inside a `tool({ execute })` already covers run-to-done machines in one line; a `toAiSdkTool(machine, executors)` helper would add the idle-handle persist/resume dance for pausing machines (see `examples/machine-as-tool`). Ships if embedders keep hand-rolling it.

## Runtime options

- **`hostContext` on `runAgent`.** Host-owned values (sessions, auth/billing ids) threaded to executors and actors without touching machine context. The documented patterns (see [host actors](host-actors.md)) cover this today via closures and input mapping; the option ships only if those prove insufficient in practice.
- **Dynamic fan-out helper.** Declarative dynamic parallelism. Today: `Promise.all` over host actors inside one invoke (see `examples/ai-sdk-orchestrator-worker`). A `fanOut(...)` helper plus per-branch progress events ships if the manual pattern proves too repetitive.

## Ecosystem

- **Storage/checkpointer adapter packages** (SQLite/Postgres/Redis) over XState persisted snapshots. Example shipped (`examples/file-snapshot-store`); packages follow demand.
- **Tracing/OTel exporter** plugging into `onTrace`.
- **Typed system-wide `onTransition`.** `runAgent`'s `inspect` passthrough already exposes every actor's transitions with their `actorRef`; a typed sugar (`onTransition` receiving `{ actorRef, path }` for child machines too) ships if hosts keep writing the same `@xstate.transition` filter.
- **Transport helpers.** SSE example shipped (`examples/sse-transport`); WebSocket and AI SDK UI stream variants next.
- **Host-loop signposting doc.** Expand the current `runAgent` vs step-loop guidance into a "pick by host type" guide if embedders still miss the split.
- **Framework migration recipes.** Parity trackers exist for selected frameworks; codemods only if demand shows.

## Next up

- **Plan executor (simulate + divergence replan).** The `agent.plan` builtin has shipped: iterated-decide, applying legal events one at a time against the live snapshot until the built-in done move, `maxSteps`, or the invoke exits its state (see [decisions](decisions.md) and `examples/todo-nl`). Next is the executor layer on top: a proposed plan is validated up front by simulating its event path against the machine; at runtime each step's actual snapshot is diffed against the simulated one, and divergence triggers a replan from the actual state under a budget. It ships as a documented pattern first, then promotes to core. Related: promoting `examples/river-crossing`'s `describeMachine` prototype to core, and a graph-search "solver mode" for pure machines via `xstate/graph`.

## Ideas (no commitment)

See the ideas parked in the repo: trajectory/experience memory over the step envelope (the world-model/ledger architecture covers this as a separate future project; keep the step envelope's per-step prediction/actual data intact so it can feed a ledger later).
