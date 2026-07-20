---
title: Compared to LangGraph and hand-rolling
description: Honest head-to-heads against LangGraph JS and a hand-rolled tool-calling loop, including where LangGraph is ahead today.
---

> **Alpha:** `@statelyai/agent` 2.0 is in alpha. APIs can change between releases; pin an exact version. Feedback: [github.com/statelyai/agent](https://github.com/statelyai/agent/issues).

## Overview

If you are choosing between this library, [LangGraph JS](https://github.com/langchain-ai/langgraphjs), and a hand-rolled loop, here is the honest comparison. The short version:

- **Vs LangGraph JS:** this is an authoring layer over XState, not a runtime with its own platform. It wins on pause/resume semantics, plain-JSON persistence, and model decoupling. LangGraph wins today on prebuilts, dynamic fan-out, and the LangSmith/Studio platform.
- **Vs a hand-rolled loop:** a `switch` loop is fine until you need durability, legality enforcement, audit/replay, or review. Each of those is real work to hand-build.

## Vs LangGraph JS

### 1. Human-in-the-loop resume

LangGraph pauses with `interrupt()` inside a node. On resume, **the node function re-executes from the top** up to the `interrupt()` call, so any side effect before the interrupt runs again unless you isolate it in its own node. The author has to remember this.

Here a waiting state **is** a state. `runAgent` settles `{ status: 'idle', snapshot }`; resume starts _at_ the waiting state, so states before it never re-enter. Pre-pause side effects and model calls run exactly once, with nothing to isolate. This is pinned by a test in `src/run-agent.test.ts` ("pre-idle side effects and model calls run exactly once").

```ts
// here: resume starts AT `reviewing`; `drafting` (and its model call) never re-runs
const first = await runAgent(machine, { input, executors }); // -> idle
const done = await runAgent(machine, {
  snapshot: first.snapshot,
  event: { type: "APPROVE" },
  executors,
});
```

See [Human in the loop](human-in-the-loop.md).

### 2. Persistence

LangGraph persists through a **checkpointer** wired to the graph, addressed by a `thread_id` in run config:

```ts
const graph = builder.compile({ checkpointer: new MemorySaver() });
await graph.invoke(input, { configurable: { thread_id: "abc" } });
const state = await graph.getState({ configurable: { thread_id: "abc" } });
```

Here the snapshot is plain JSON you store anywhere, with no checkpointer to wire and no thread addressing:

```ts
const result = await runAgent(machine, { input, executors });
await store.put(id, JSON.stringify(result.snapshot)); // any DB, file, queue, localStorage
// later, any process:
await runAgent(machine, { snapshot: JSON.parse(await store.get(id)), event, executors });
```

Context must be JSON-serializable; that is the one constraint. See [Human in the loop](human-in-the-loop.md#persist-and-resume-across-processes).

### 3. Model coupling

LangGraph nodes typically hold LangChain model objects (`ChatOpenAI`, `ChatAnthropic`) and call them inside node code, so swapping SDKs means editing nodes.

Here the machine never talks to a model. It emits typed requests; a host resolves them with an executor set of up to three plain functions: `generateText`/`streamText` return `{ output }`, `decide` returns `{ event }` (the chosen event object). Swap SDKs by swapping executors; the machine is untouched.

```ts
const executors = createAiSdkExecutors({ models }); // Vercel AI SDK adapter
// or createOpenAiCompatExecutors({ baseUrl }), or hand-rolled { generateText, decide }
await runAgent(machine, { input, executors });
```

See [Hosts and executors](hosts.md).

### 4. Where LangGraph is ahead today

- **Prebuilts.** `createReactAgent(...)` is a one-liner tool-calling agent. Here you author the states yourself (though [examples/react-agent](../examples/react-agent) shows the same loop, and the Vercel AI SDK loop can run inside a state).
- **Dynamic fan-out.** LangGraph's `Send` API fans out to N branches at runtime cleanly. Fan-out invokes are landing in XState ([statelyai/xstate#5602](https://github.com/statelyai/xstate/pull/5602)) and will close this gap; see [examples/fan-out](../examples/fan-out) for what works today.
- **Platform.** LangSmith tracing and LangGraph Studio are a mature, hosted observability and debugging platform. Here you get Stately's visualization and `onTrace`/JSONL, but not a hosted platform of that depth.

## Vs hand-rolling a switch-loop

A `while` loop over `switch (phase)` is the right first move. It is readable, has no dependencies, and for a linear tool-calling agent it may never need to be anything else. Do not reach for a machine before you feel the pain.

Structure earns its place when one of these four shows up. Each is cheap in a machine and real work to hand-build:

| What you need                                     | Hand-rolled cost                                                                                                         | Here                                                                                                                                           |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **Durable pause/resume across processes**         | Serialize loop-local state, rebuild it on load, and make sure no pre-pause work re-runs. Easy to get subtly wrong.       | Settle `idle`, persist the JSON snapshot, resume with an event. Pre-pause work runs once by construction.                                      |
| **Enforcing which actions are legal mid-flow**    | Hand-written `if` checks scattered per phase; the model can still request an out-of-bounds action and you catch it late. | Guards make illegal transitions return `undefined`; the model can only choose a currently-legal event. See [Decisions](decisions.md).          |
| **Audit / replay of what happened**               | Bolt on your own event log, then keep it in sync with the mutations.                                                     | The [step path](steps.md) is event-sourced: each step applies one event; persist the ordered log and replay deterministically.                 |
| **Visualization / review by teammates or agents** | None; the flow lives only in code.                                                                                       | The machine is a graph: inspect it in Stately, review it visually, or hand the JSON to an agent. See [Machines as data](machines-as-data.md). |

The trade: a machine is more upfront structure than a loop. The payoff is that these four capabilities come from the shape of the machine instead of being hand-maintained. If you need none of them, a loop is genuinely fine.

## Related

- [Human in the loop](human-in-the-loop.md)
- [Decisions](decisions.md)
- [The step path](steps.md)
- [Migrating from a hand-rolled loop](from-a-loop.md)
