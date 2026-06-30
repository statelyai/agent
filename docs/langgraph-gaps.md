# LangGraph Gap Tracker

This tracks remaining gaps one by one. The goal is not to clone LangGraph; it is to make `@statelyai/agent` the better choice when developers want explicit, typed, visual state machine agents with flexible runtime ownership.

## Product Gaps

| Gap | Why it matters | Likely shape |
| --- | --- | --- |
| Checkpoint adapters | LangGraph users expect durable threads/checkpoints without inventing storage glue. | Example first, then optional packages for SQLite/Postgres/Redis using XState persisted snapshots. |
| UI streaming transports | Demos need to feel complete in React/Svelte/HTTP/WebSocket apps. | Host-side stream examples using AI SDK UI streams and WebSocket/SSE. |
| Interrupt/resume helpers | HITL is expressible today, but LangGraph has explicit interrupt ergonomics. | Small helpers/patterns around states, events, and persisted snapshots. |
| Prebuilt supervisor/swarm helpers | Current tests prove expressibility, but some users want a shortcut. | Additive helpers built on XState `setup(...)` and `createTextLogic(...)`, not a separate runtime. |
| Long-term memory/store examples | RAG is covered as host actors; storage ownership needs clearer examples. | Retrieval/storage actors with local and hosted backend examples. |
| Observability/tracing | Visualization covers static structure; runtime traces are separate. | XState inspection hooks plus OpenTelemetry/LangSmith-style host examples. |
| LangGraph migration tooling | Parity is manual today. | Documented recipes first; optional graph-to-XState codemod later. |
| Platform-only features | LangGraph Platform includes hosted threads, cron, deployment, Studio. | Out of package scope unless Stately platform integration becomes a goal. |

## Coverage Status

- Covered in tests: branching, HITL, tool calling, streaming, persistence, subflows, supervisor routing, map-reduce, RAG, reflection, ReWOO, SQL-style agents, persistent multi-agent networks.
- Covered by package surface: typed XState `setup(...)`, reusable named text actors with `createTextLogic(...)`, host-provided execution, XState snapshots, graph/mermaid export.
- Not yet covered by polished examples: checkpoint storage adapters, UI streaming transports, memory backends, tracing, migration guide.

## Recommended Order

1. Add UI streaming examples with Vercel AI SDK and plain Web Streams.
2. Add checkpoint adapter examples using XState persisted snapshots.
3. Add interrupt/resume helper docs.
4. Add memory/retrieval backend examples.
5. Decide whether supervisor/swarm helpers deserve package API.
