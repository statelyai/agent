# LangGraphJS Parity

## Scope

This document tracks where `@statelyai/agent` currently matches the practical end result of `langchain-ai/langgraphjs` for core workflow/runtime behavior.

It is intentionally scoped to:

- core orchestration concepts
- durable session behavior
- streaming/runtime transport behavior
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

The parity target here is the core graph/runtime layer, not the whole surrounding product/package ecosystem.

## Matrix

<!-- parity matrix derived from examples/index.ts, src/langgraph-equivalents/*.test.ts, and docs/langgraph-parity.md scope -->

| LangGraphJS concept | Status | Agent equivalent |
| --- | --- | --- |
| Branching / conditional routing | Covered | [`examples/branching.ts`](/Users/davidkpiano/Code/agent/examples/branching.ts), [`src/langgraph-equivalents/branching.test.ts`](/Users/davidkpiano/Code/agent/src/langgraph-equivalents/branching.test.ts) |
| Subgraphs / nested flows | Covered | [`examples/subflow.ts`](/Users/davidkpiano/Code/agent/examples/subflow.ts), [`examples/conditional-subflow.ts`](/Users/davidkpiano/Code/agent/examples/conditional-subflow.ts), [`src/langgraph-equivalents/subflow.test.ts`](/Users/davidkpiano/Code/agent/src/langgraph-equivalents/subflow.test.ts), [`src/langgraph-equivalents/conditional-subflow.test.ts`](/Users/davidkpiano/Code/agent/src/langgraph-equivalents/conditional-subflow.test.ts) |
| Human-in-the-loop / approval gate | Covered | [`examples/hitl.ts`](/Users/davidkpiano/Code/agent/examples/hitl.ts), [`src/langgraph-equivalents/hitl.test.ts`](/Users/davidkpiano/Code/agent/src/langgraph-equivalents/hitl.test.ts) |
| Durable sessions / restore from snapshots + events | Covered | [`examples/persistence.ts`](/Users/davidkpiano/Code/agent/examples/persistence.ts), [`src/langgraph-equivalents/persistence.test.ts`](/Users/davidkpiano/Code/agent/src/langgraph-equivalents/persistence.test.ts) |
| Streaming emitted parts | Covered | [`examples/persistent-streaming.ts`](/Users/davidkpiano/Code/agent/examples/persistent-streaming.ts), [`src/langgraph-equivalents/streaming.test.ts`](/Users/davidkpiano/Code/agent/src/langgraph-equivalents/streaming.test.ts), [`src/langgraph-equivalents/persistent-streaming.test.ts`](/Users/davidkpiano/Code/agent/src/langgraph-equivalents/persistent-streaming.test.ts) |
| Tool calling with intermediate progress | Covered | [`examples/tool-calling.ts`](/Users/davidkpiano/Code/agent/examples/tool-calling.ts), [`src/langgraph-equivalents/tool-calling.test.ts`](/Users/davidkpiano/Code/agent/src/langgraph-equivalents/tool-calling.test.ts) |
| Retry loops / explicit recovery | Covered | [`examples/error-retry.ts`](/Users/davidkpiano/Code/agent/examples/error-retry.ts), [`src/langgraph-equivalents/error-retry.test.ts`](/Users/davidkpiano/Code/agent/src/langgraph-equivalents/error-retry.test.ts) |
| Plan-and-execute | Covered | [`examples/plan-and-execute.ts`](/Users/davidkpiano/Code/agent/examples/plan-and-execute.ts), [`src/langgraph-equivalents/plan-and-execute.test.ts`](/Users/davidkpiano/Code/agent/src/langgraph-equivalents/plan-and-execute.test.ts) |
| Map-reduce style workflows | Covered | [`examples/map-reduce.ts`](/Users/davidkpiano/Code/agent/examples/map-reduce.ts), [`src/langgraph-equivalents/map-reduce.test.ts`](/Users/davidkpiano/Code/agent/src/langgraph-equivalents/map-reduce.test.ts) |
| Reflection loop | Covered | [`examples/reflection.ts`](/Users/davidkpiano/Code/agent/examples/reflection.ts), [`src/langgraph-equivalents/reflection.test.ts`](/Users/davidkpiano/Code/agent/src/langgraph-equivalents/reflection.test.ts) |
| ReWOO-style planner / worker decomposition | Covered | [`examples/rewoo.ts`](/Users/davidkpiano/Code/agent/examples/rewoo.ts), [`src/langgraph-equivalents/rewoo.test.ts`](/Users/davidkpiano/Code/agent/src/langgraph-equivalents/rewoo.test.ts) |
| Supervisor routing | Covered | [`examples/supervisor.ts`](/Users/davidkpiano/Code/agent/examples/supervisor.ts), [`examples/persistent-supervisor.ts`](/Users/davidkpiano/Code/agent/examples/persistent-supervisor.ts), [`src/langgraph-equivalents/supervisor.test.ts`](/Users/davidkpiano/Code/agent/src/langgraph-equivalents/supervisor.test.ts), [`src/langgraph-equivalents/persistent-supervisor.test.ts`](/Users/davidkpiano/Code/agent/src/langgraph-equivalents/persistent-supervisor.test.ts) |
| Multi-agent handoffs | Covered | [`examples/multi-agent-network.ts`](/Users/davidkpiano/Code/agent/examples/multi-agent-network.ts), [`examples/persistent-multi-agent-network.ts`](/Users/davidkpiano/Code/agent/examples/persistent-multi-agent-network.ts), [`src/langgraph-equivalents/multi-agent-network.test.ts`](/Users/davidkpiano/Code/agent/src/langgraph-equivalents/multi-agent-network.test.ts), [`src/langgraph-equivalents/persistent-multi-agent-network.test.ts`](/Users/davidkpiano/Code/agent/src/langgraph-equivalents/persistent-multi-agent-network.test.ts) |
| SQL/tool-heavy agent workflow | Covered | [`examples/sql-agent.ts`](/Users/davidkpiano/Code/agent/examples/sql-agent.ts), [`src/langgraph-equivalents/sql-agent.test.ts`](/Users/davidkpiano/Code/agent/src/langgraph-equivalents/sql-agent.test.ts) |
| ReAct-style agent | Covered | [`examples/react-agent-from-scratch.ts`](/Users/davidkpiano/Code/agent/examples/react-agent-from-scratch.ts), [`examples/react-agent.ts`](/Users/davidkpiano/Code/agent/examples/react-agent.ts), [`src/langgraph-equivalents/prebuilt-react.test.ts`](/Users/davidkpiano/Code/agent/src/langgraph-equivalents/prebuilt-react.test.ts) |
| Message-centric chatbot state | Covered | [`examples/chatbot-messages.ts`](/Users/davidkpiano/Code/agent/examples/chatbot-messages.ts), [`src/langgraph-equivalents/chatbot-messages.test.ts`](/Users/davidkpiano/Code/agent/src/langgraph-equivalents/chatbot-messages.test.ts) |
| Retrieval-augmented generation | Covered | [`examples/rag.ts`](/Users/davidkpiano/Code/agent/examples/rag.ts), [`src/langgraph-equivalents/rag.test.ts`](/Users/davidkpiano/Code/agent/src/langgraph-equivalents/rag.test.ts) |
| HTTP session transport | Covered | [`examples/http-session.ts`](/Users/davidkpiano/Code/agent/examples/http-session.ts), [`src/examples.test.ts`](/Users/davidkpiano/Code/agent/src/examples.test.ts) |
| Durable HTTP streaming transport / reconnect | Covered | [`examples/http-streaming-session.ts`](/Users/davidkpiano/Code/agent/examples/http-streaming-session.ts), [`src/examples.test.ts`](/Users/davidkpiano/Code/agent/src/examples.test.ts) |
| Graph export / visualization support | Covered | [`src/graph/index.ts`](/Users/davidkpiano/Code/agent/src/graph/index.ts), [`src/xstate/index.ts`](/Users/davidkpiano/Code/agent/src/xstate/index.ts), [`src/langgraph-equivalents/graph.test.ts`](/Users/davidkpiano/Code/agent/src/langgraph-equivalents/graph.test.ts) |

## Intentional differences

These are currently deliberate, not gaps:

- Logic stays pure: `(state, event) -> { nextState, effects }`.
- Emitted events are live runtime effects, not durable journal entries.
- Durable behavior is based on first-class snapshot + event persistence rather than in-memory graph execution with optional add-ons.
- `run.on(...)` is reserved for emitted events only; terminal/runtime hooks use dedicated methods like `run.onDone(...)`.
- Parallelism is expected to be expressed in plain JavaScript where possible, rather than forcing a dedicated graph primitive when `Promise.all(...)` is enough.

## Still missing or intentionally out of scope

These are the main areas not yet covered by a first-class parity example:

- swarm-specific helper APIs comparable to `libs/langgraph-swarm`
- published checkpoint backends as separate installable packages
- UI framework transport examples comparable to `examples/ui-react`, `examples/ui-svelte`, etc.
- platform-only features such as threads, cron jobs, Studio, and deployment APIs

## Recommended next wave

1. Decide whether swarm/supervisor helper packages should exist as additive libraries or remain plain examples.
2. Decide whether storage adapters should stay example-level or become installable packages.
3. Only after that, consider UI transport helpers if package surface matters beyond examples.
