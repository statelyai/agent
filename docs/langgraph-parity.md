# LangGraphJS Parity

## Scope

This document tracks where authored `@statelyai/agent` machines can model the practical end result of `langchain-ai/langgraphjs` examples.

It is intentionally scoped to:

- state-machine authoring concepts
- full type-safe XState authoring through `setupAgent(...)` (or plain `setup({ schemas, actorSources })`) and reusable `createTextLogic(...)`/`createDecisionLogic(...)` actors
- XState actor, snapshot, and host-adapter behavior
- adapter and transport example behavior
- runnable examples and tests in this repo

It is intentionally not scoped to:

- LangGraph Platform deployment features
- LangGraph Studio
- LangGraph UI / framework SDK packages
- checkpoint backend packages as separate published adapters

## External reference

As of April 25, 2026, the upstream `langgraphjs` repo exposes:

- core packages under [`libs/`](https://github.com/langchain-ai/langgraphjs/tree/main/libs), including `langgraph`, `langgraph-core`, checkpoint packages, supervisor/swarm helpers, SDKs, and UI packages
- runnable examples under [`examples/`](https://github.com/langchain-ai/langgraphjs/tree/main/examples), including quickstart, plan-and-execute, reflection, rewoo, SQL agent, multi-agent, chatbots, RAG, and UI transport examples

The parity target here is authoring semantics and adapter targets, not a replacement runtime or the whole surrounding product/package ecosystem.

## Why choose this

The strongest reason to choose `@statelyai/agent` over LangGraph is that the workflow is just XState:

- no hidden graph runtime is required
- every transition, guard, actor, snapshot, and event is inspectable
- TypeScript checks the machine boundary, external events, and typed host actors
- model and tool execution stay in host code, so Vercel AI SDK, LangChain, Workers AI, SQL clients, and local functions remain swappable
- visualization stays in Stately Studio and the upcoming VS Code extension, not this package

The strongest reason to choose it over handrolling is that agent control flow is usually the product. Once a workflow needs branching, review gates, retries, persistence, subflows, or multi-agent routing, plain async functions become implicit state machines. `createTextLogic(...)` makes model steps individually testable, and plain XState `setup(...)` makes the state machine explicit without taking over the runtime.

Remaining gaps are tracked in [`langgraph-gaps.md`](/Users/davidkpiano/Code/agent/docs/langgraph-gaps.md).

## Matrix

<!-- parity matrix derived from examples/langgraph-*/metadata.json and docs/langgraph-parity.md scope -->

Each row links the migrated example and states the mechanism in one line — not a bare "Covered".

| LangGraphJS concept | Agent example | Mechanism |
| --- | --- | --- |
| Graph/state-machine authoring with typed state/events | [`examples/email-drafter/index.ts`](/Users/davidkpiano/Code/agent/examples/email-drafter/index.ts) | XState `setup(...)`/`setupAgent(...)` with schema-typed context, events, and named `requests:` |
| Decisions (model picks one legal event) | [`examples/twenty-questions/index.ts`](/Users/davidkpiano/Code/agent/examples/twenty-questions/index.ts) | inline `agent.decide` invoke + `allowedEvents`, validated and retried by `resolveDecision` against guard-legal events |
| Branching / conditional routing | [`examples/langgraph-conditional-routing/index.test.ts`](/Users/davidkpiano/Code/agent/examples/langgraph-conditional-routing/index.test.ts) | Guarded transitions / function-form `on:` handlers |
| Subgraphs / nested flows | [`examples/langgraph-subflows/index.test.ts`](/Users/davidkpiano/Code/agent/examples/langgraph-subflows/index.test.ts) | A child machine invoked as a nested actor; the parent binds only its own request sources via `runAgent`, the child's sources are bound separately with `.provide(...)` |
| Human-in-the-loop / approval gate | [`examples/langgraph-human-in-the-loop/index.test.ts`](/Users/davidkpiano/Code/agent/examples/langgraph-human-in-the-loop/index.test.ts) | Idle-first: a no-invoke state settles `runAgent` to `{ status: 'idle' }`; resume with `{ snapshot, event }` |
| Session restore from snapshots | [`examples/langgraph-snapshot-persistence/index.test.ts`](/Users/davidkpiano/Code/agent/examples/langgraph-snapshot-persistence/index.test.ts) | JSON-serializable `snapshot` round-tripped through a store between `runAgent` calls |
| Streaming side channels | [`examples/langgraph-streaming-side-channel/index.test.ts`](/Users/davidkpiano/Code/agent/examples/langgraph-streaming-side-channel/index.test.ts), [`examples/ai-sdk-host/index.ts`](/Users/davidkpiano/Code/agent/examples/ai-sdk-host/index.ts) | `runAgent`'s `onChunk(chunk, { request })`; the machine transitions only on final text |
| Tool calling with intermediate progress | [`examples/langgraph-tool-calling-progress/index.test.ts`](/Users/davidkpiano/Code/agent/examples/langgraph-tool-calling-progress/index.test.ts) | Tool calls as host-executed actors reporting through `onChunk`/`onResult` |
| Plan-and-execute | [`examples/langgraph-plan-and-execute/index.test.ts`](/Users/davidkpiano/Code/agent/examples/langgraph-plan-and-execute/index.test.ts) | Planner request produces structured output; execution states iterate the plan |
| Map-reduce / fan-out workflows | [`examples/langgraph-map-reduce/index.test.ts`](/Users/davidkpiano/Code/agent/examples/langgraph-map-reduce/index.test.ts) | Plain `Promise.all(...)` over host actors inside a single invoke — no dedicated fan-out primitive (see alpha status in the readme) |
| Reflection / retry loops | [`examples/langgraph-reflection-loop/index.test.ts`](/Users/davidkpiano/Code/agent/examples/langgraph-reflection-loop/index.test.ts) | Explicit draft/critique/check states sharing a critique schema, re-entered via guarded transition |
| ReWOO-style planner / worker decomposition | [`examples/langgraph-rewoo/index.test.ts`](/Users/davidkpiano/Code/agent/examples/langgraph-rewoo/index.test.ts) | Planner output schema, worker evidence map, and a final solver state |
| Supervisor routing | [`examples/langgraph-supervisor-handoff/index.test.ts`](/Users/davidkpiano/Code/agent/examples/langgraph-supervisor-handoff/index.test.ts) | A routing request's structured output selects the target state/actor |
| Multi-agent handoffs | [`examples/langgraph-persistent-multi-agent-network/index.test.ts`](/Users/davidkpiano/Code/agent/examples/langgraph-persistent-multi-agent-network/index.test.ts) | Supervisor routing to typed child actors, persisted across turns via snapshot |
| SQL/tool-heavy agent workflow | [`examples/langgraph-sql-agent/index.test.ts`](/Users/davidkpiano/Code/agent/examples/langgraph-sql-agent/index.test.ts) | Query generation, DB execution, and answer synthesis as separate typed states |
| Message-centric chatbot state | [`src/setup-agent.ts`](/Users/davidkpiano/Code/agent/src/setup-agent.ts) | `messagesSchema` (parts-based `AgentMessage` union), `appendMessages(...)`, plain XState context |
| Retrieval-augmented generation | [`examples/langgraph-rag/index.test.ts`](/Users/davidkpiano/Code/agent/examples/langgraph-rag/index.test.ts) | Retrieval as a typed host actor; generation as a named request |
| HTTP / framework transport | — | Possible but manual: host XState actors behind HTTP, WebSocket, Cloudflare Agents, or any framework runtime; no shipped transport helper (see the readme's alpha-status list) |
| ReAct-style agent | — | Possible but manual: express as explicit observe/think/act states or typed tool-actor loops; no dedicated ReAct helper ships |

## XState coverage

`setupAgent(...)` (or plain XState `setup(...)` plus `createTextLogic(...)`) is the first-class path. Current tests cover these applicable LangGraph example shapes with typed XState machines, `runAgent(...)`, and local `createActor(...)` execution:

- decisions (model chooses one guard-legal event, with typed retry)
- conditional routing
- human-in-the-loop approval (idle-first)
- plan-and-execute with generated structured output plus local actors
- subflows and supervisor routing
- map-reduce fan-out and reduction
- RAG retrieval plus generation
- reflection loops
- ReWOO planner/worker/solver decomposition
- SQL-style query/tool/synthesis flow
- persistent multi-agent networks
- persistence from XState snapshots
- host-side streaming side channels
- tool-calling as typed host actors
- schema-carrying named requests
- host replacement through `machine.provide({ actorSources })` and `.withExecutor(...)`

## Intentional differences

These are currently deliberate, not gaps:

- Logic stays pure: `(state, event) -> { nextState, effects }`.
- Developers author normal XState with `setup(...)`/`setupAgent(...)`; LangGraph-style workflows map without giving up runtime control.
- Sent events (e.g. a decision's chosen event) are observable runtime effects on the actor, not durable journal entries by default — see the readme's step-path section for the event-sourcing framing when that durability is needed.
- Session behavior is based on first-class snapshot + event contracts; production durability belongs in host adapters.
- Parallelism is expected to be expressed in plain JavaScript (`Promise.all(...)`) inside a host actor, rather than a dedicated graph fan-out primitive — see "not yet" below.

## Still missing or intentionally out of scope

Aligned with the readme's alpha-status list — see [`../readme.md`](/Users/davidkpiano/Code/agent/readme.md#alpha-status--whats-not-here-yet) for the authoritative list. As of this writing, not yet shipped:

- storage/checkpointer adapters (recipe-level only; no published SQLite/Postgres/Redis packages)
- tracing/OTel exporter (use `onResult`/`onTransition` as the seam)
- SSE/WebSocket transport helpers (host your own stream)
- a dedicated dynamic-parallelism (Send-style) helper — `Promise.all(...)` inside a host actor is the current pattern
- swarm-specific helper APIs comparable to `libs/langgraph-swarm`
- UI framework transport examples comparable to `examples/ui-react`, `examples/ui-svelte`, etc.
- platform-only features such as threads, cron jobs, Studio, and deployment APIs

## Recommended next wave

1. Decide whether swarm/supervisor helper packages should exist as additive libraries or remain plain examples.
2. Decide whether storage adapters should stay example-level or become installable packages.
3. Only after that, consider UI transport helpers if package surface matters beyond examples.
