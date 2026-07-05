# LangGraph Gap Tracker

This is the "not yet" list, kept in sync with the readme's alpha-status section ([`../readme.md`](/Users/davidkpiano/Code/agent/readme.md#alpha-status--whats-not-here-yet)). The goal is not to clone LangGraph; it's to make `@statelyai/agent` the better choice for developers who want explicit, typed state machine agents with flexible runtime ownership — and to be honest about what that doesn't include yet in this alpha.

## Product Gaps

| Gap | Current state | Why it matters | Likely shape |
| --- | --- | --- | --- |
| Storage/checkpointer adapters | Example shipped, no adapter package yet: a file-backed snapshot store in [`examples/file-snapshot-store`](/Users/davidkpiano/Code/agent/examples/file-snapshot-store), plus the idle-first HITL pattern exercised by [`examples/human-in-the-loop/index.test.ts`](/Users/davidkpiano/Code/agent/examples/human-in-the-loop/index.test.ts) | LangGraph users expect durable threads/checkpoints without inventing storage glue. | Example shipped; optional packages for SQLite/Postgres/Redis using XState persisted snapshots still to come. |
| Tracing/OTel exporter | Not shipped — `onResult`/`onTransition` on `runAgent` are the observation seam | Runtime traces are separate from static machine rendering in Stately Studio and the VS Code extension. | An OpenTelemetry/LangSmith-style exporter plugging into `onResult`. |
| SSE/WebSocket transport | Example shipped, no transport package yet: an SSE transport over the `onChunk` seam in [`examples/sse-transport`](/Users/davidkpiano/Code/agent/examples/sse-transport); host still owns the transport | Demos need to feel complete in React/Svelte/HTTP/WebSocket apps. | SSE example shipped; WebSocket and AI SDK UI stream examples still to come. |
| Dynamic-parallelism (Send-style) helpers | Possible but manual — `Promise.all(...)` over host actors inside one invoke, see [`examples/ai-sdk-orchestrator-worker/index.test.ts`](/Users/davidkpiano/Code/agent/examples/ai-sdk-orchestrator-worker/index.test.ts) | LangGraph's `Send` gives dynamic fan-out without predeclaring branches. | A helper on top of `Promise.all(...)` if the manual pattern proves too repetitive. |
| Nested-machine executor binding | Manual — `runAgent` binds only the top-level machine's own sources; a child machine's sources are bound separately via `.provide(...)`, see [`examples/subflows/index.test.ts`](/Users/davidkpiano/Code/agent/examples/subflows/index.test.ts) | Multi-machine composition is common in larger agent systems. | Possibly a `runAgent` option to walk and bind nested machine sources automatically. |
| Interrupt/resume helpers | Idle-first HITL is the primitive today (no-invoke state + `runAgent` settling `idle`) | LangGraph has explicit `interrupt()` ergonomics; this library's version is a state-shape pattern, not a function call. | Small helper/lint patterns around the idle-state convention, not a new runtime concept. |
| Prebuilt supervisor/swarm helpers | Expressible today via typed child actors and routing requests, not a dedicated helper | Current tests prove expressibility, but some users want a shortcut. | Additive helpers built on `setupAgent(...)`, not a separate runtime. |
| Visualization tooling | Out of package scope | Diagramming/inspection belongs in Stately Studio and the in-progress VS Code extension, not this package. | N/A — external tooling, not a package gap. |
| LangGraph migration tooling | Parity is manual today (this doc + `langgraph-parity.md`) | Parity is manual today. | Documented recipes first; optional graph-to-XState codemod later. |
| Platform-only features | Out of scope | LangGraph Platform includes hosted threads, cron, deployment, Studio. | Out of package scope unless Stately platform integration becomes a goal. |

## Coverage Status

- Covered in tests: decisions, branching, idle-first HITL, tool calling, streaming, persistence, subflows, supervisor routing, map-reduce, RAG, reflection, ReWOO, SQL-style agents, persistent multi-agent networks.
- Covered by package surface: `setupAgent(...)`, typed XState `setup(...)`, reusable named requests with `createTextLogic(...)`/`createDecisionLogic(...)`, host-provided execution via `runAgent`/`createAiSdkExecutors`, XState snapshots, the step path for durable/checkpointed hosts.
- Covered by a shipped example, not yet a package: file-backed snapshot store ([`examples/file-snapshot-store`](/Users/davidkpiano/Code/agent/examples/file-snapshot-store)), SSE transport ([`examples/sse-transport`](/Users/davidkpiano/Code/agent/examples/sse-transport)), machine-as-tool ([`examples/machine-as-tool`](/Users/davidkpiano/Code/agent/examples/machine-as-tool)).
- Not yet covered by a shipped package or polished example: storage/checkpointer adapters (SQLite/Postgres/Redis), tracing/OTel exporter, WebSocket transport, dynamic-parallelism helpers, automatic nested-machine binding, migration tooling.

## Recommended Order

1. Promote the file-backed snapshot store example to optional SQLite/Postgres/Redis adapter packages.
2. Add an `onResult`-based tracing/OTel exporter example.
3. Extend the SSE transport example with WebSocket and Vercel AI SDK UI stream variants.
4. Decide whether a dynamic-parallelism helper is worth adding over the `Promise.all(...)` pattern.
5. Decide whether supervisor/swarm helpers or nested-machine auto-binding deserve package API.
