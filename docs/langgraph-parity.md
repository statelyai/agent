# LangGraphJS Parity

## Scope

This document tracks where authored `@statelyai/agent` machines can model the practical end result of `langchain-ai/langgraphjs` examples.

It is intentionally scoped to:

- state-machine authoring concepts
- full type-safe XState authoring through `setup({ schemas, actorSources })` and reusable `createTextLogic(...)` actors
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
- visualization comes from the authored machine, not a separate reconstruction
- model and tool execution stay in host code, so Vercel AI SDK, LangChain, Workers AI, SQL clients, and local functions remain swappable

The strongest reason to choose it over handrolling is that agent control flow is usually the product. Once a workflow needs branching, review gates, retries, persistence, subflows, or multi-agent routing, plain async functions become implicit state machines. `createTextLogic(...)` makes model steps individually testable, and plain XState `setup(...)` makes the state machine explicit without taking over the runtime.

Remaining gaps are tracked in [`langgraph-gaps.md`](/Users/davidkpiano/Code/agent/docs/langgraph-gaps.md).

## Matrix

<!-- parity matrix derived from examples/langgraph-*/metadata.json and docs/langgraph-parity.md scope -->

| LangGraphJS concept | Status | Agent equivalent |
| --- | --- | --- |
| Graph/state-machine authoring with typed state/events | Covered | XState `setup(...)`, `createTextLogic(...)`, [`examples/email-drafter/index.ts`](/Users/davidkpiano/Code/agent/examples/email-drafter/index.ts), [`src/setup-agent.test.ts`](/Users/davidkpiano/Code/agent/src/setup-agent.test.ts), [`examples/langgraph-conditional-routing/index.test.ts`](/Users/davidkpiano/Code/agent/examples/langgraph-conditional-routing/index.test.ts) |
| Branching / conditional routing | Covered | [`examples/langgraph-conditional-routing/index.test.ts`](/Users/davidkpiano/Code/agent/examples/langgraph-conditional-routing/index.test.ts) |
| Subgraphs / nested flows | Covered | [`examples/langgraph-subflows/index.test.ts`](/Users/davidkpiano/Code/agent/examples/langgraph-subflows/index.test.ts) |
| Human-in-the-loop / approval gate | Covered | [`examples/langgraph-human-in-the-loop/index.test.ts`](/Users/davidkpiano/Code/agent/examples/langgraph-human-in-the-loop/index.test.ts) |
| Session restore from snapshots | Covered | [`examples/langgraph-snapshot-persistence/index.test.ts`](/Users/davidkpiano/Code/agent/examples/langgraph-snapshot-persistence/index.test.ts) |
| Streaming side channels | Covered | [`examples/langgraph-streaming-side-channel/index.test.ts`](/Users/davidkpiano/Code/agent/examples/langgraph-streaming-side-channel/index.test.ts), [`examples/ai-sdk-host/index.ts`](/Users/davidkpiano/Code/agent/examples/ai-sdk-host/index.ts) |
| Tool calling with intermediate progress | Covered | [`examples/langgraph-tool-calling-progress/index.test.ts`](/Users/davidkpiano/Code/agent/examples/langgraph-tool-calling-progress/index.test.ts) |
| Plan-and-execute | Covered | [`examples/langgraph-plan-and-execute/index.test.ts`](/Users/davidkpiano/Code/agent/examples/langgraph-plan-and-execute/index.test.ts) |
| Map-reduce / fan-out workflows | Covered | Expressed with normal XState actors plus `Promise.all(...)`; see [`examples/langgraph-map-reduce/index.test.ts`](/Users/davidkpiano/Code/agent/examples/langgraph-map-reduce/index.test.ts) |
| Reflection / retry loops | Covered | Explicit draft/critique/check loop with shared critique schema in [`examples/langgraph-reflection-loop/index.test.ts`](/Users/davidkpiano/Code/agent/examples/langgraph-reflection-loop/index.test.ts) |
| ReWOO-style planner / worker decomposition | Covered | Planner output schema, worker evidence map, and final solver state in [`examples/langgraph-rewoo/index.test.ts`](/Users/davidkpiano/Code/agent/examples/langgraph-rewoo/index.test.ts) |
| Supervisor routing | Covered | [`examples/langgraph-supervisor-handoff/index.test.ts`](/Users/davidkpiano/Code/agent/examples/langgraph-supervisor-handoff/index.test.ts) |
| Multi-agent handoffs | Covered | Expressed as supervisor routing to typed child actors; see [`examples/langgraph-persistent-multi-agent-network/index.test.ts`](/Users/davidkpiano/Code/agent/examples/langgraph-persistent-multi-agent-network/index.test.ts) |
| SQL/tool-heavy agent workflow | Covered | Query generation, DB execution, and answer synthesis are separate typed states in [`examples/langgraph-sql-agent/index.test.ts`](/Users/davidkpiano/Code/agent/examples/langgraph-sql-agent/index.test.ts) |
| ReAct-style agent | Covered | Expressed as explicit observe/think/act states or typed tool actor loops |
| Message-centric chatbot state | Covered | `messagesSchema`, `appendMessages(...)`, and plain XState context in [`src/setup-agent.ts`](/Users/davidkpiano/Code/agent/src/setup-agent.ts) |
| Retrieval-augmented generation | Covered | Retrieval is a typed host actor; generation is named text logic invoked as `src: 'answerQuestion'` |
| HTTP / framework transport | Adapter example | Host XState actors behind HTTP, WebSocket, Cloudflare Agents, or any framework runtime |
| Graph export / visualization support | Covered | Authored machines are normal XState machines and can use the XState/Stately visualization path directly |

## XState coverage

Plain XState `setup(...)` with `createTextLogic(...)` is the first-class path. Current tests cover these applicable LangGraph example shapes with typed XState machines and local `createActor(...)` execution:

- conditional routing
- human-in-the-loop approval
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
- schema-carrying named text logic
- host replacement through `machine.provide({ actorSources })`

## Intentional differences

These are currently deliberate, not gaps:

- Logic stays pure: `(state, event) -> { nextState, effects }`.
- Developers author normal XState with `setup(...)`; LangGraph-style workflows map without giving up runtime control.
- Emitted events are live runtime effects, not durable journal entries.
- Session behavior is based on first-class snapshot + event contracts; production durability belongs in adapters.
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
