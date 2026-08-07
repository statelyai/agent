---
title: Coming from LangGraph
description: A term-by-term translation of LangGraph concepts onto agent machines, plus the ported examples for each pattern.
---

> **Alpha:** `@statelyai/agent` 2.0 is in alpha. APIs can change between releases; pin an exact version. Feedback: [github.com/statelyai/agent](https://github.com/statelyai/agent/issues).

If you already think in graphs, nodes, edges, and checkpoints, most of what you know transfers directly. This page is a translation guide: LangGraph term on the left, the equivalent here on the right, and the example that shows it running.

**You don't have to choose.** [examples/langchain-host](../examples/langchain-host/index.ts) keeps LangChain for model calls, callbacks, tracing through LangSmith (LangChain's hosted observability product), and the agent loop while the machine owns control flow: wrap any `BaseChatModel` as executors, or hand a `createAgent` loop the machine as tools.

## Term mapping

| LangGraph                              | Here                                               | How it maps                                                                                                                                                                                                                                                                                   |
| -------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `StateGraph(State)`                    | `setupAgent({ ... }).createMachine({ ... })`       | `setupAgent` declares the schemas (context, input, output, events) once; `createMachine` builds the typed graph. See [Agent machines](machines.md).                                                                                                                                           |
| Graph state / reducers                 | `context` + transition functions                   | Context is the typed state object. A transition returns the next `context`, so a reducer becomes an ordinary function of `{ context, event }`.                                                                                                                                                |
| Node (`add_node`)                      | A state with an `invoke`                           | A node's work is the state's invoked actor: a text request, a decision, or a plain actor. Entering the state starts the work; `onDone` writes the result into context.                                                                                                                        |
| Edge (`add_edge`)                      | `onDone.target` or an `always` transition          | A fixed edge is the target of the state's completion.                                                                                                                                                                                                                                         |
| `add_conditional_edges`                | Guarded transitions, or `type: 'choice'`           | A branch is a transition function returning a different target (or `undefined` to block). Deterministic branches use the `choice` pseudo-state; model-chosen branches use `agent.decide`.                                                                                                     |
| Router node returning a literal        | `agent.decide` with `allowedEvents`                | The model chooses one machine event from the currently legal set; the event's transition is the branch. See [Decisions](decisions.md).                                                                                                                                                        |
| `interrupt()`                          | An idle state with an `on:` handler                | A pause is a state that invokes nothing and waits for an event. `runAgent` settles `idle`, hands back a snapshot, and the run resumes when you send the event. See [Human in the loop](human-in-the-loop.md).                                                                                 |
| `Command(resume=...)`                  | The resume event you send                          | Resuming is sending a typed event (`APPROVE`, `EDIT`, `REJECT`) into the restored snapshot. The payload is schema-validated.                                                                                                                                                                  |
| `interrupt_before` on a tool           | An idle state before the tool state                | Model the approval point as its own state; the tool state is only reachable through it. See [`review-tool-calls`](../examples/review-tool-calls/index.ts).                                                                                                                                    |
| Checkpointer (`MemorySaver`, Postgres) | `persistSnapshot` or the event log                 | Two options: persist the JSON snapshot yourself, or append the event log and replay it. Neither requires a configured backend to run. See [The event log](event-log.md).                                                                                                                      |
| `thread_id`                            | Your own key + a log or snapshot per key           | There is no built-in thread registry. Use whatever key your app already has (session id, row id) and store the snapshot or log entries under it.                                                                                                                                              |
| Time travel / `get_state_history`      | Snapshot list, or `replay` plus the store's `fork` | Rewind by replaying a prefix of the log (or restoring an earlier snapshot); `fork` is a method on the event-log store, not a root export, and copies a prefix into a new thread you then append to. See [`time-travel`](../examples/time-travel/index.ts).                                    |
| `Send(...)` for map-reduce             | Spawned child actors                               | A planner produces N items and the machine spawns one child branch per item; a reducer state composes the results. See [`fan-out`](../examples/fan-out/index.ts).                                                                                                                             |
| Subgraphs                              | Child machines invoked as actors                   | A machine is an actor, so a subgraph is an `invoke` of another agent machine with its own typed input/output. See [Multi-agent](multi-agent.md) and [`subflows`](../examples/subflows/index.ts).                                                                                              |
| `create_agent` / `create_react_agent`  | One request with `tools`, or an explicit loop      | Default: one state, `tools` on the request, your SDK runs the loop (`metadata.maxSteps` bounds it); see [`tool-calling`](../examples/tool-calling/index.ts). When turns need gating or mid-loop persistence, unroll to visible states; see [`react-agent`](../examples/react-agent/index.ts). |
| Tool binding (`bind_tools`)            | Request-level `tools`, or tool states              | Tools the model calls inside one request are declared on the request; tools that should be their own graph step are states. See [Text requests](text-requests.md#tools-and-multi-step-loops).                                                                                                 |
| `stream_mode`                          | `onChunk`, `onTransition`, `onTrace`               | Text chunks stream through the request's `onChunk`; state changes through `onTransition`; a structured trace through `onTrace`. See [Observability](observability.md).                                                                                                                        |
| Provider model object                  | `models` registry + host executors                 | The machine names a model ref; the [host](hosts.md) resolves it. The same machine runs against any provider by swapping executors.                                                                                                                                                            |

## Side-by-side code

Every LangGraph/agent-machine code pair lives in [LangGraph vs agent machines](langgraph-comparison.md):

- [Conditional edges and guards](langgraph-comparison.md#conditional-edges-and-guards): a router function versus a decision over named events with a guard bound.
- [The same agent, both ways](langgraph-comparison.md#in-langgraph): an `interrupt()` node versus an idle state plus a JSON snapshot.
- [Dimension by dimension](langgraph-comparison.md#dimension-by-dimension): where the two designs actually diverge, and [when to prefer LangGraph](langgraph-comparison.md#langgraph-strengths).

## Ported examples

Several LangGraph tutorials and how-tos exist here as runnable examples, so you can read the same problem in both shapes. Full list in [examples/README.md](../examples/README.md).

- [`corrective-rag`](../examples/corrective-rag/index.ts): the CRAG tutorial as explicit states (retrieve, grade, rewrite query, web-search fallback, grounded generate).
- [`adaptive-rag`](../examples/adaptive-rag/index.ts): route local vs web, grade retrieval and generation, bounded rewrite.
- [`reflection-writer`](../examples/reflection-writer/index.ts): the reflection essay-writer, generate ↔ critique with a typed revision bound.
- [`code-assistant`](../examples/code-assistant/index.ts): self-correcting code generation with a sandboxed check step and a bounded attempt budget.
- [`customer-support`](../examples/customer-support/index.ts): the flagship customer-support tutorial, with `interrupt_before` as a real gate state.
- [`review-tool-calls`](../examples/review-tool-calls/index.ts): `interrupt` + `Command(resume=...)` as approve / edit / reject events over a proposed tool call.
- [`time-travel`](../examples/time-travel/index.ts): the time-travel how-to as checkpoint history, rewind, and a forked branch.
- [`tool-calling`](../examples/tool-calling/index.ts): `create_agent`'s job in one state; the SDK runs the tool loop inside a single request.
- [`react-agent`](../examples/react-agent/index.ts): the same loop unrolled into a visible, budgeted machine when turns need gating.
- [`fan-out`](../examples/fan-out/index.ts): `Send`-style dynamic map-reduce via spawned child branches.
- [`supervisor`](../examples/supervisor/index.ts) and [`hierarchical-teams`](../examples/hierarchical-teams/index.ts): supervisor handoff and two-level teams.
- [`deep-research`](../examples/deep-research/index.ts): plan queries, research in parallel, reflect, synthesize.
- [`lats`](../examples/lats/index.ts): Language Agent Tree Search with a rollout budget.

## Related

- [LangGraph vs agent machines](langgraph-comparison.md): one agent built both ways, with an honest dimension table and when to prefer LangGraph.
- [Quickstart](quickstart.md): install and run one machine end to end.
- [Migrating from a loop](from-a-loop.md): the same conversion starting from hand-rolled `while`-loop code.
- [Thinking in state machines](thinking-in-state-machines.md): naming the states hiding in an agent loop, and binding LLM work to them.
- [Agent patterns](patterns.md): the pattern-to-example map.
