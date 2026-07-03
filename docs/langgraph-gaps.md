# LangGraph Gap Tracker

This is the "not yet" list, kept in sync with the readme's alpha-status section ([`../readme.md`](/Users/davidkpiano/Code/agent/readme.md#alpha-status--whats-not-here-yet)). The goal is not to clone LangGraph; it's to make `@statelyai/agent` the better choice for developers who want explicit, typed state machine agents with flexible runtime ownership — and to be honest about what that doesn't include yet in this alpha.

## Product Gaps

| Gap | Current state | Why it matters | Likely shape |
| --- | --- | --- | --- |
| Storage/checkpointer adapters | Recipe only — see the idle-first HITL pattern in the readme, exercised by [`examples/langgraph-snapshot-persistence/index.test.ts`](/Users/davidkpiano/Code/agent/examples/langgraph-snapshot-persistence/index.test.ts) | LangGraph users expect durable threads/checkpoints without inventing storage glue. | Example first, then optional packages for SQLite/Postgres/Redis using XState persisted snapshots. |
| Tracing/OTel exporter | Not shipped — `onResult`/`onTransition` on `runAgent` are the observation seam | Runtime traces are separate from static machine rendering in Stately Studio and the VS Code extension. | An OpenTelemetry/LangSmith-style exporter plugging into `onResult`. |
| SSE/WebSocket transport | Not shipped — `onChunk` is the streaming seam, host owns the transport | Demos need to feel complete in React/Svelte/HTTP/WebSocket apps. | Host-side stream examples using AI SDK UI streams and WebSocket/SSE. |
| Dynamic-parallelism (Send-style) helpers | Possible but manual — `Promise.all(...)` over host actors inside one invoke, see [`examples/langgraph-map-reduce/index.test.ts`](/Users/davidkpiano/Code/agent/examples/langgraph-map-reduce/index.test.ts) | LangGraph's `Send` gives dynamic fan-out without predeclaring branches. | A helper on top of `Promise.all(...)` if the manual pattern proves too repetitive. |
| Nested-machine executor binding | Manual — `runAgent` binds only the top-level machine's own sources; a child machine's sources are bound separately via `.provide(...)`, see [`examples/langgraph-subflows/index.test.ts`](/Users/davidkpiano/Code/agent/examples/langgraph-subflows/index.test.ts) | Multi-machine composition is common in larger agent systems. | Possibly a `runAgent` option to walk and bind nested machine sources automatically. |
| Interrupt/resume helpers | Idle-first HITL is the primitive today (no-invoke state + `runAgent` settling `idle`) | LangGraph has explicit `interrupt()` ergonomics; this library's version is a state-shape pattern, not a function call. | Small helper/lint patterns around the idle-state convention, not a new runtime concept. |
| Prebuilt supervisor/swarm helpers | Expressible today via typed child actors and routing requests, not a dedicated helper | Current tests prove expressibility, but some users want a shortcut. | Additive helpers built on `setupAgent(...)`, not a separate runtime. |
| Visualization tooling | Out of package scope | Diagramming/inspection belongs in Stately Studio and the in-progress VS Code extension, not this package. | N/A — external tooling, not a package gap. |
| LangGraph migration tooling | Parity is manual today (this doc + `langgraph-parity.md`) | Parity is manual today. | Documented recipes first; optional graph-to-XState codemod later. |
| Platform-only features | Out of scope | LangGraph Platform includes hosted threads, cron, deployment, Studio. | Out of package scope unless Stately platform integration becomes a goal. |

## Coverage Status

- Covered in tests: decisions, branching, idle-first HITL, tool calling, streaming, persistence, subflows, supervisor routing, map-reduce, RAG, reflection, ReWOO, SQL-style agents, persistent multi-agent networks.
- Covered by package surface: `setupAgent(...)`, typed XState `setup(...)`, reusable named requests with `createTextLogic(...)`/`createDecisionLogic(...)`, host-provided execution via `runAgent`/`createAiSdkExecutors`, XState snapshots, the step path for durable/checkpointed hosts.
- Not yet covered by a shipped package or polished example: storage/checkpointer adapters, tracing/OTel exporter, SSE/WebSocket transport, dynamic-parallelism helpers, automatic nested-machine binding, migration tooling.

## Recommended Order

1. Add checkpoint adapter examples using XState persisted snapshots.
2. Add an `onResult`-based tracing/OTel exporter example.
3. Add UI streaming examples with Vercel AI SDK and plain Web Streams.
4. Decide whether a dynamic-parallelism helper is worth adding over the `Promise.all(...)` pattern.
5. Decide whether supervisor/swarm helpers or nested-machine auto-binding deserve package API.
