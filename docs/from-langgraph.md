---
title: Coming from LangGraph
description: A term-by-term translation of LangGraph concepts onto agent machines, plus the ported examples for each pattern.
---

> **Alpha:** `@statelyai/agent` 2.0 is in alpha. APIs can change between releases; pin an exact version. Feedback: [github.com/statelyai/agent](https://github.com/statelyai/agent/issues).

If you already think in graphs, nodes, edges, and checkpoints, most of what you know transfers directly. This page is a translation guide: LangGraph term on the left, the equivalent here on the right, and the example that shows it running.

**You don't have to choose.** [examples/langchain-host](../examples/langchain-host/index.ts) keeps LangChain for model calls, callbacks, LangSmith tracing, and the agent loop while the machine owns control flow: wrap any `BaseChatModel` as executors, or hand a `createAgent` loop the machine as tools.

## Term mapping

| LangGraph                              | Here                                               | How it maps                                                                                                                                                                                                                                                                                     |
| -------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `StateGraph(State)`                    | `setupAgent({ ... }).createMachine({ ... })`       | `setupAgent` declares the schemas (context, input, output, events) once; `createMachine` builds the typed graph. See [Agent machines](machines.md).                                                                                                                                             |
| Graph state / reducers                 | `context` + transition functions                   | Context is the typed state object. A transition returns the next `context`, so a reducer becomes an ordinary function of `{ context, event }`.                                                                                                                                                  |
| Node (`add_node`)                      | A state with an `invoke`                           | A node's work is the state's invoked actor: a text request, a decision, or a plain actor. Entering the state starts the work; `onDone` writes the result into context.                                                                                                                          |
| Edge (`add_edge`)                      | `onDone.target` or an `always` transition          | A fixed edge is the target of the state's completion.                                                                                                                                                                                                                                           |
| `add_conditional_edges`                | Guarded transitions, or `type: 'choice'`           | A branch is a transition function returning a different target (or `undefined` to block). Deterministic branches use the `choice` pseudo-state; model-chosen branches use `agent.decide`.                                                                                                       |
| Router node returning a literal        | `agent.decide` with `allowedEvents`                | The model chooses one machine event from the currently legal set; the event's transition is the branch. See [Decisions](decisions.md).                                                                                                                                                          |
| `interrupt()`                          | An idle state with an `on:` handler                | A pause is a state that invokes nothing and waits for an event. `runAgent` settles `idle`, hands back a snapshot, and the run resumes when you send the event. See [Human in the loop](human-in-the-loop.md).                                                                                   |
| `Command(resume=...)`                  | The resume event you send                          | Resuming is sending a typed event (`APPROVE`, `EDIT`, `REJECT`) into the restored snapshot. The payload is schema-validated.                                                                                                                                                                    |
| `interrupt_before` on a tool           | An idle gate state before the tool state           | Model the approval point as its own state; the tool state is only reachable through it. See [`review-tool-calls`](../examples/review-tool-calls/index.ts).                                                                                                                                      |
| Checkpointer (`MemorySaver`, Postgres) | `persistSnapshot` or the event log                 | Two options: persist the JSON snapshot yourself, or append the event log and replay it. Neither requires a configured backend to run. See [The event log](event-log.md).                                                                                                                        |
| `thread_id`                            | Your own key + a log or snapshot per key           | There is no built-in thread registry. Use whatever key your app already has (session id, row id) and store the snapshot or log entries under it.                                                                                                                                                |
| Time travel / `get_state_history`      | Snapshot list, or `replay` plus the store's `fork` | Rewind by replaying a prefix of the log (or restoring an earlier snapshot); `fork` is a method on the event-log store, not a root export, and copies a prefix into a new thread you then append to. See [`time-travel`](../examples/time-travel/index.ts).                                      |
| `Send(...)` for map-reduce             | Spawned child actors                               | A planner produces N items and the machine spawns one child branch per item; a reducer state composes the results. See [`fan-out`](../examples/fan-out/index.ts).                                                                                                                               |
| Subgraphs                              | Child machines invoked as actors                   | A machine is an actor, so a subgraph is an `invoke` of another agent machine with its own typed input/output. See [Multi-agent](multi-agent.md) and [`subflows`](../examples/subflows/index.ts).                                                                                                |
| `create_agent` / `create_react_agent`  | One request with `tools`, or an explicit loop      | Default: one state, `tools` on the request, your SDK runs the loop (`metadata.maxSteps` bounds it) — see [`tool-calling`](../examples/tool-calling/index.ts). When turns need gating or mid-loop persistence, unroll to visible states — see [`react-agent`](../examples/react-agent/index.ts). |
| Tool binding (`bind_tools`)            | Request-level `tools`, or tool states              | Tools the model calls inside one request are declared on the request; tools that should be their own graph step are states. See [Text requests](text-requests.md#tools-and-multi-step-loops).                                                                                                   |
| `stream_mode`                          | `onChunk`, `onTransition`, `onTrace`               | Text chunks stream through the request's `onChunk`; state changes through `onTransition`; a structured trace through `onTrace`. See [Observability](observability.md).                                                                                                                          |
| Provider model object                  | `models` registry + host executors                 | The machine names a model ref; the [host](hosts.md) resolves it. The same machine runs against any provider by swapping executors.                                                                                                                                                              |

## Two shapes side by side

Each pair below is the LangGraph code first (`@langchain/langgraph` 1.x), then the same thing here.

**A conditional edge becomes a guarded transition.** In LangGraph, a node produces a literal and a router function turns it into a node name. The rewrite bound is an `if` inside that router:

```ts
import {
  END,
  START,
  StateGraph,
  StateSchema,
  type ConditionalEdgeRouter,
  type GraphNode,
} from "@langchain/langgraph";
import { z } from "zod";

const State = new StateSchema({
  question: z.string(),
  docs: z.string(),
  grade: z.string().default(""),
  rewrites: z.number().default(0),
});

const grade: GraphNode<typeof State> = async (state) => {
  const res = await model.invoke([
    {
      role: "system",
      content: "Reply GENERATE if the documents answer the question, else REWRITE.",
    },
    { role: "user", content: `Question:\n${state.question}\n\nDocuments:\n${state.docs}` },
  ]);
  // Whatever the model said, unvalidated, is now the routing key.
  return { grade: res.text.trim() };
};

const route: ConditionalEdgeRouter<typeof State, "generate" | "rewrite"> = (state) =>
  state.grade === "REWRITE" && state.rewrites < 2 ? "rewrite" : "generate";

const graph = new StateGraph(State)
  .addNode("grade", grade)
  .addNode("generate", generate)
  .addNode("rewrite", rewrite)
  .addEdge(START, "grade")
  .addConditionalEdges("grade", route, ["generate", "rewrite"])
  .addEdge("generate", END)
  .compile();
```

Here, the router is a decision the model makes over named events; the branch is the event's transition, and a guard returning `undefined` makes that branch unavailable:

```ts
grading: {
  invoke: {
    src: "agent.decide",
    input: ({ context }) => ({
      model: "grader",
      system: "GENERATE if the documents answer the question, else REWRITE.",
      prompt: `Question:\n${context.question}\n\nDocuments:\n${context.docs}`,
      allowedEvents: ["GENERATE", "REWRITE"],
    }),
  },
  on: {
    GENERATE: { target: "generating" },
    // Bound the correction loop: past 2 rewrites, REWRITE is illegal.
    REWRITE: ({ context }) =>
      context.rewrites < 2
        ? { target: "rewriting", context: { rewrites: context.rewrites + 1 } }
        : undefined,
  },
}
```

The model never sees the bound as prose. It picks `REWRITE`, the guard rejects it, the attempt is recorded as `rejected-by-guard`, and the model is asked again with that feedback.

The model never sees a routing string it can typo. It picks a named event, and the bound is a guard rather than an `if` the router owns.

**An interrupt becomes a state that waits.** In LangGraph, the pause is a runtime call inside a node, and it only works if a checkpointer and a `thread_id` are configured. Resuming re-enters the node from the top:

```ts
import { Command, MemorySaver, interrupt, type GraphNode } from "@langchain/langgraph";

const review: GraphNode<typeof State> = (state) => {
  const decision = interrupt({ draft: state.draft, action: "approve or reject" }) as
    | { type: "approve" }
    | { type: "reject" };
  return { approved: decision.type === "approve" };
};

// Without a checkpointer, interrupt() cannot resume at all.
const graph = builder.compile({ checkpointer: new MemorySaver() });

const config = { configurable: { thread_id: "email-42" } };
const first = await graph.invoke({ request }, config);

first.__interrupt__; // [{ id, value: { draft, action } }]

const done = await graph.invoke(new Command({ resume: { type: "approve" } }), config);
```

Here, no checkpointer is configured; the run settles and gives you a snapshot:

```ts
// inside states: { ... }, invokes nothing, so the run settles idle here
reviewing: {
  on: {
    APPROVE: { target: "sending" },
    REJECT: { target: "drafting" },
  },
},
```

```ts
import { getAcceptedEvents, runAgent } from "@statelyai/agent";

const first = await runAgent(machine, { input, executors });

if (first.status === "idle") {
  await store.save(key, JSON.stringify(first.persistedSnapshot));
  // getAcceptedEvents(first.snapshot) -> the exact choices to render
}

// ...a later request, possibly another process...
const resumed = await runAgent(machine, {
  snapshot: JSON.parse(await store.load(key)),
  event: { type: "APPROVE" },
  executors,
});
```

The `key` is whatever your app already uses; there is no separate thread registry to configure.

## What is structurally different

Three differences are worth knowing up front, because they change how you design rather than just how you spell things.

**Legality comes from machine guards, not from what the model was given.** A decision offers the events the current state accepts, and the chosen event still has to pass its guard (`snapshot.can(event)`) before it is applied. A model that picks a currently-illegal event gets a typed `rejected-by-guard` attempt and is asked again. Constraints live in the machine, so they hold no matter what the prompt says.

**Pauses are plain states, not a runtime mechanism.** There is no `interrupt()` call and no checkpointer requirement: a state that waits for an event is the pause. `runAgent` settles `idle` and returns a serializable snapshot; the accepted events at that point are enumerable with `getAcceptedEvents`, so a UI can render exactly the choices the machine will honor. Persistence is a separate decision (snapshot, event log, or nothing) rather than a precondition for pausing.

**Verification runs without a model.** Because the graph is data and guards are ordinary functions, `lintAgentMachine`, `canReach`, `explorePaths`, and `simulateAgent` check reachability, dead states, and scripted playthroughs with no API key and no network. See [Testing and verification](verify.md).

## Ported examples

Several LangGraph tutorials and how-tos exist here as runnable examples, so you can read the same problem in both shapes. Full list in [examples/README.md](../examples/README.md).

- [`corrective-rag`](../examples/corrective-rag/index.ts): the CRAG tutorial as explicit states (retrieve, grade, rewrite query, web-search fallback, grounded generate).
- [`adaptive-rag`](../examples/adaptive-rag/index.ts): route local vs web, grade retrieval and generation, bounded rewrite.
- [`reflection-writer`](../examples/reflection-writer/index.ts): the reflection essay-writer, generate ↔ critique with a typed revision bound.
- [`code-assistant`](../examples/code-assistant/index.ts): self-correcting code generation with a sandboxed check step and a bounded attempt budget.
- [`customer-support`](../examples/customer-support/index.ts): the flagship customer-support tutorial, with `interrupt_before` as a real gate state.
- [`review-tool-calls`](../examples/review-tool-calls/index.ts): `interrupt` + `Command(resume=...)` as approve / edit / reject events over a proposed tool call.
- [`time-travel`](../examples/time-travel/index.ts): the time-travel how-to as checkpoint history, rewind, and a forked branch.
- [`tool-calling`](../examples/tool-calling/index.ts): `create_agent`'s job in one state — the SDK runs the tool loop inside a single request.
- [`react-agent`](../examples/react-agent/index.ts): the same loop unrolled into a visible, budgeted machine when turns need gating.
- [`fan-out`](../examples/fan-out/index.ts): `Send`-style dynamic map-reduce via spawned child branches.
- [`supervisor`](../examples/supervisor/index.ts) and [`hierarchical-teams`](../examples/hierarchical-teams/index.ts): supervisor handoff and two-level teams.
- [`deep-research`](../examples/deep-research/index.ts): plan queries, research in parallel, reflect, synthesize.
- [`lats`](../examples/lats/index.ts): Language Agent Tree Search with a rollout budget.

## Where to go next

- [LangGraph vs agent machines](langgraph-comparison.md): one agent built both ways, with an honest dimension table and when to prefer LangGraph.
- [Quickstart](quickstart.md): install and run one machine end to end.
- [Migrating from a loop](from-a-loop.md): the same conversion starting from hand-rolled `while`-loop code.
- [Agent patterns](patterns.md): the pattern-to-example map, copy-paste sized.
