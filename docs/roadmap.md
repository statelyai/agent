---
title: Post-alpha roadmap
description: Work deliberately deferred past the 2.0 alpha, and why.
---

> **Alpha:** `@statelyai/agent` 2.0 is in alpha. APIs can change between releases; pin an exact version. Feedback: [github.com/statelyai/agent](https://github.com/statelyai/agent/issues).

Everything here is **additive**: none of it blocks the alpha, and all of it benefits from real usage feedback before the API shape is chosen. If you hit one of these and have opinions, open an issue; that feedback is what this list is waiting on. The one exception is the section below: the road to stable is gating, not additive.

## Road to v2 stable (gating)

v2 leaves alpha only when its durable formats can be promised. Changing a persisted format after stable is worse than staying alpha longer, so these land in order and formats freeze last:

- **Runtime semantics complete first.** The durable-execution seams still moving (step request envelope, execution info, checkpoint contract, dynamic actor binding) settle before any freeze; freezing around them would lock in their current gaps.
- **Stable XState v6.** The alpha pins `xstate@6.0.0-alpha.*`; v2 stable requires a stable v6 (persisted snapshot format is XState's, so its stability is a hard dependency). This is external schedule risk: if v6 stable slips, v2 stays alpha rather than freezing on an alpha snapshot format.
- **Node LTS matrix.** Declare and CI-test the supported active LTS versions.
- **Format freeze.** The durable formats freeze together, with documented versioning rules: the journal entry format (the reserved `@agent.init` entry plus external-input events), the `AgentEventLogStore` protocol, and the `AgentTraceEvent` envelope (`AGENT_TRACE_SCHEMA_VERSION`). Persisted snapshots are compaction caches, versioned by XState.
- **Upgrade tests.** Fixture snapshots and traces from the frozen formats, replayed in CI against every release, so a break is caught before it ships.
- **RC cycle.** At least one release candidate with the formats frozen and real hosts running against it before `2.0.0`.

## Helpers (deferred until real usage shows the shape)

- **Managed thin-loop helper.** A collapsed `await driveAgent(machine, { entries, executors, actorSources, store })` over the journal loop (see [the step path](steps.md)). Deferred because the loop is ~15 lines of host-owned code by design; a helper ships if alpha users keep hand-rolling the same wrapper.
- **Idle persist/revive helper.** The persist snapshot, return pending handle, resume with event recipe (see [human in the loop](human-in-the-loop.md)) is currently a documented pattern rewritten by each host. A small helper lands once a couple of real stores (SQLite, Postgres, Redis) show the common shape.
- **Result narrowing accessor.** `result.status === 'done' ? result.output : undefined` appears at many call sites; a typed accessor could erase it.
- **Provider executor scaffolding.** Hand-rolling a raw-SDK executor is ~400 lines (see `examples/openai-sdk-host`, `examples/anthropic-sdk-host`). A `createExecutorsFromChat(...)` scaffold could cut that to ~60; deferred until a third provider example exposes the right seams. (`getJsonSchema` itself shipped; the scaffold would build on it.)
- **Schema compiler recipes.** Keep core zero-dependency and avoid blessing one JSON Schema engine in the main package. If JSON-config users keep copying the Ajv adapter, add cookbook snippets or optional adapter packages outside core.
- **Machine-as-tool helper.** `runAgent` inside a `tool({ execute })` already covers run-to-done machines in one line; a `toAiSdkTool(machine, executors)` helper would add the idle-handle persist/resume dance for pausing machines (see `examples/machine-as-tool`). Ships if users keep hand-rolling it.

## Runtime options

- **`hostContext` on `runAgent`.** Host-owned values (sessions, auth/billing ids) threaded to executors and actors without touching machine context. The documented patterns (see [threading host context](hosts.md#threading-host-context-into-actors-and-requests)) cover this today via closures and input mapping; the option ships only if those prove insufficient in practice.
- **`requestId` on the live path.** The thin loop derives deterministic effect identity (`site#occurrence`) for idempotency keys; `runAgent`'s live executors receive `{ signal, onChunk }` but no `requestId`. Thread it through for journal parity if live hosts adopt idempotent downstreams. (The old step-path executor-info gap dissolved with the host-owned loop: the host calls executors directly and closes over whatever it needs.)
- **Dynamic fan-out: live-path mid-flight resume.** Executor binding for dynamic spawns is solved: action args expose `actorSources` (the post-`provide` implementations map, which `runAgent` binds in full), so `enq.spawn(actorSources.someRequest, ...)` receives the run's executors with no pre-binding (see `examples/fan-out`). Mid-flight crash recovery is solved on the journal path: `replay` re-derives still-owed spawned effects from the event log (pinned in `src/effects.test.ts`). The remaining seam is the **live** path only: `runAgent` restoring a snapshot persisted while spawned children were in flight drops the frozen children (documented and test-marked in `examples/fan-out`) — revive-from-snapshot is an XState question; journal replay is the durable answer.

## Ecosystem

- **Storage/checkpointer adapter packages** (SQLite/Postgres/Redis) over XState persisted snapshots. Example shipped (`examples/file-snapshot-store`); packages follow demand.
- **Tracing/OTel exporter** plugging into `onTrace`.
- **Typed system-wide `onTransition`.** `runAgent`'s `inspect` passthrough already exposes every actor's transitions with their `actorRef`; a typed sugar (`onTransition` receiving `{ actorRef, path }` for child machines too) ships if hosts keep writing the same `@xstate.transition` filter.
- **Transport helpers.** SSE example shipped (`examples/sse-transport`); WebSocket and AI SDK UI stream variants next.
- **Host-loop signposting doc.** Expand the current `runAgent` vs step-loop guidance into a "pick by host type" guide if users still miss the split.
- **Framework migration recipes.** Parity trackers exist for selected frameworks; codemods only if demand shows.

## Next up

- **Plan executor (simulate + divergence replan).** The `agent.plan` builtin has shipped: iterated-decide, applying legal events one at a time against the live snapshot until the built-in done move, `maxSteps`, or the invoke exits its state (see [decisions](decisions.md) and `examples/todo-nl`). Next is the executor layer on top: a proposed plan is validated up front by simulating its event path against the machine; at runtime each step's actual snapshot is diffed against the simulated one, and divergence triggers a replan from the actual state under a budget. It ships as a documented pattern first, then promotes to core. Related: promoting `examples/river-crossing`'s `describeMachine` prototype to core, and a graph-search "solver mode" for pure machines via `xstate/graph`.
- **Blessed introspection tools for `agent.decide`/`agent.plan`.** The machine can already predict what a candidate event would do (`machine.transition(...)` against the current snapshot: next state, whether anything changed). Rather than always rendering previews into the prompt, expose them as blessed machine-only tool calls the model may invoke before committing (`previewEvent(event)` → next state + changed, `describeState()`): the agent chooses when a preview is worth the extra call, so the common case pays no prompt bloat. Ships behind an explicit option if guard feedback alone proves insufficient.
- **Decide coercion seam.** `system`/`prompt` on `agent.decide` are author-owned and `renderDecisionAttempts` covers retry feedback, but how candidates are presented to the model (tool-per-event naming, option descriptions) is buried in each host's `decide` executor; customizing it today means rewriting the executor. A `renderCandidates`-style option on the decide input would give a middle knob without forking the adapter. Parked to see whether real hosts ask for it.

## Ideas (no commitment)

See the ideas parked in the repo: trajectory/experience memory over the step envelope (the world-model/ledger architecture covers this as a separate future project; keep the step envelope's per-step prediction/actual data intact so it can feed a ledger later).
