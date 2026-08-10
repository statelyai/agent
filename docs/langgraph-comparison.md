---
title: Coming from LangGraph
description: A term-by-term translation of LangGraph concepts, the same agent built both ways, an honest dimension-by-dimension comparison, and the ported examples.
---

> **Alpha:** `@statelyai/agent` 2.0 is in alpha. APIs can change between releases; pin an exact version. Feedback: [github.com/statelyai/agent](https://github.com/statelyai/agent/issues).

[LangGraph](https://docs.langchain.com/oss/javascript/langgraph) and `@statelyai/agent` solve overlapping problems: both give an LLM workflow explicit structure, both pause for humans, both persist and resume. They disagree about where control flow lives.

This page starts with a term-by-term translation, builds one small agent in both, compares them dimension by dimension, then lists the LangGraph tutorials ported as runnable examples.

**You don't have to choose.** [examples/langchain-host](../examples/langchain-host/index.ts) keeps LangChain for model calls, callbacks, tracing through LangSmith (LangChain's hosted observability product), and the agent loop while the machine owns control flow: wrap any `BaseChatModel` as executors, or hand a `createAgent` loop the machine as tools.

Code blocks are illustrative and not typechecked in this repo. LangGraph snippets target `@langchain/langgraph` 1.x.

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

## The agent

An email assistant with a human gate:

1. Draft an email from a request.
2. Stop and show the draft to a human.
3. Approve sends it; revise loops back to drafting with feedback.
4. At most 3 revisions, then it must be approved or dropped.

Same four moving parts in both: a model call, a pause, a loop, and a bound on the loop.

## In LangGraph

```ts no-check
import { z } from "zod";
import {
  Command,
  END,
  MemorySaver,
  START,
  StateGraph,
  StateSchema,
  interrupt,
  type ConditionalEdgeRouter,
  type GraphNode,
} from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";

// Model IDs here are illustrative; substitute your provider's current models.
const model = new ChatOpenAI({ model: "gpt-4.1-mini" });

const State = new StateSchema({
  request: z.string(),
  draft: z.string().default(""),
  feedback: z.string().default(""),
  revisions: z.number().default(0),
});

const draft: GraphNode<typeof State> = async (state) => {
  const res = await model.invoke([
    { role: "system", content: "Draft a short, professional email." },
    {
      role: "user",
      content: state.feedback
        ? `${state.request}\n\nRevise this draft:\n${state.draft}\n\nFeedback: ${state.feedback}`
        : state.request,
    },
  ]);
  return { draft: res.text, revisions: state.revisions + 1 };
};

// The pause. Requires a checkpointer at compile time, and the whole node
// re-runs from the top when the graph resumes.
const review: GraphNode<typeof State> = (state) => {
  const decision = interrupt({ draft: state.draft, action: "approve or revise" }) as
    | { type: "approve" }
    | { type: "revise"; feedback: string };

  return { feedback: decision.type === "revise" ? decision.feedback : "" };
};

const send: GraphNode<typeof State> = async (state) => {
  await mailer.send(state.draft);
  return {};
};

// The revision bound is an `if` inside a router function.
const route: ConditionalEdgeRouter<typeof State, "draft" | "send"> = (state) =>
  state.feedback && state.revisions < 3 ? "draft" : "send";

const graph = new StateGraph(State)
  .addNode("draft", draft)
  .addNode("review", review)
  .addNode("send", send)
  .addEdge(START, "draft")
  .addEdge("draft", "review")
  .addConditionalEdges("review", route, ["draft", "send"])
  .addEdge("send", END)
  .compile({ checkpointer: new MemorySaver() });
```

Running it, with `thread_id` as the durable pointer back to the saved checkpoint:

```ts
const config = { configurable: { thread_id: "email-42" } };

const first = await graph.invoke(
  { request: "Ask Dana to move Thursday's review to Friday" },
  config,
);

first.__interrupt__; // [{ id, value: { draft, action } }]

const done = await graph.invoke(new Command({ resume: { type: "approve" } }), config);
```

## In `@statelyai/agent`

```ts
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { getAcceptedEvents, persistSnapshot, runAgent, setupAgent } from "@statelyai/agent";
import { createAiSdkExecutors, defineModels } from "@statelyai/agent/ai-sdk";

const models = defineModels({ writer: openai("gpt-4.1-mini") });

const agentSetup = setupAgent({
  models,
  context: z.object({
    request: z.string(),
    draft: z.string().nullable(),
    feedback: z.string().nullable(),
    revisions: z.number(),
  }),
  input: z.object({ request: z.string() }),
  output: z.object({ draft: z.string() }),
  events: {
    APPROVE: {}, // `{}` is shorthand for a payload-less event
    REVISE: z.object({ feedback: z.string() }),
  },
  requests: {
    writeDraft: {
      schemas: {
        input: z.object({ request: z.string(), feedback: z.string().nullable() }),
        output: z.object({ draft: z.string() }),
      },
      model: "writer",
      system: "Draft a short, professional email.",
      prompt: ({ input }) =>
        input.feedback ? `${input.request}\n\nRevise per: ${input.feedback}` : input.request,
    },
  },
});

const machine = agentSetup.createMachine({
  context: ({ input }) => ({
    request: input.request,
    draft: null,
    feedback: null,
    revisions: 0,
  }),
  output: ({ context }) => ({ draft: context.draft ?? "" }),
  initial: "drafting",
  states: {
    drafting: {
      invoke: {
        src: "writeDraft",
        input: ({ context }) => ({ request: context.request, feedback: context.feedback }),
        onDone: ({ output }) => ({ target: "reviewing", context: { draft: output.draft } }),
      },
    },
    // No invoke, so runAgent settles { status: 'idle', snapshot } here.
    reviewing: {
      on: {
        APPROVE: { target: "sent" },
        // The revision bound is a guard. Past 3 revisions, REVISE stops being
        // an accepted event at all: no router can route around it.
        REVISE: ({ context, event }) =>
          context.revisions < 3
            ? {
                target: "drafting",
                context: { feedback: event.feedback, revisions: context.revisions + 1 },
              }
            : undefined,
      },
    },
    sent: { type: "final" },
  },
});
```

Running it, with your own key and no configured backend:

```ts
const executors = createAiSdkExecutors({ models });

const first = await runAgent(machine, {
  input: { request: "Ask Dana to move Thursday's review to Friday" },
  executors,
});

if (first.status === "idle") {
  getAcceptedEvents(first.snapshot); // ['APPROVE', 'REVISE'], the exact choices to render
  await store.save("email-42", JSON.stringify(persistSnapshot(first.snapshot)));
}

// ...a later request, possibly another process...
const done = await runAgent(machine, {
  snapshot: JSON.parse(await store.load("email-42")),
  event: { type: "APPROVE" },
  executors,
});
```

## Conditional edges and guards

The second pair, since routing is where the designs diverge hardest. In LangGraph a node produces a literal and a router function turns it into a node name; the rewrite bound is an `if` inside that router:

```ts no-check
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

Here the router is a decision the model makes over named events. The branch is the event's transition, and a guard returning `undefined` makes that branch unavailable:

```ts no-check
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

There is no routing string to typo and no bound stated as prose. The model picks a named event; if the guard rejects it, the attempt is recorded as `rejected-by-guard` and the model is asked again with that feedback.

## Dimension by dimension

| Dimension             | LangGraph                                                                                                                                                                                                                             | `@statelyai/agent`                                                                                                                                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Graph definition      | `new StateGraph(State)` with `addNode` / `addEdge` / `addConditionalEdges`, compiled to a Pregel runtime.                                                                                                                             | `setupAgent(...).createMachine(...)`: a statechart with nested and parallel states, entry/exit actions, and invoked actors.                                                                                                 |
| Control-flow legality | A conditional router is a function returning a node name; `Command({ goto })` can also jump from inside a node. Bounds like "max 3 revisions" are `if`s the runtime does not enforce.                                                 | Transitions are declared per state. A guard returning `undefined` makes the transition illegal, and `snapshot.can(event)` is checked before anything is applied. Illegal paths are not authorable.                          |
| Model-chosen branches | A node returns a literal that the router matches on. Parsing and validating the model's answer is your code.                                                                                                                          | `agent.decide` offers the model only the events the current state accepts, intersected with `allowedEvents`. An illegal or guard-rejected pick is recorded as a typed attempt and re-asked. See [Decisions](decisions.md).  |
| State                 | Channels declared with `StateSchema`, merged by reducers (`ReducedValue`, `MessagesValue`). Nodes return partial updates.                                                                                                             | A single typed `context` object, updated by transition functions returning partial context. A reducer becomes an ordinary function of `{ context, event }`.                                                                 |
| Human in the loop     | `interrupt(payload)` inside a node, resumed with `Command({ resume })`. Requires a checkpointer and a `thread_id`; the interrupting node re-executes from the top on resume.                                                          | A state with no invoke. `runAgent` settles `idle` and hands back a JSON snapshot. No runtime primitive, no checkpointer requirement, and nothing re-executes. See [Human in the loop](human-in-the-loop.md).                |
| Rendering the choices | The `interrupt` payload is whatever you passed; the UI's option list is prose you keep in sync by hand.                                                                                                                               | `getAcceptedEvents(snapshot)` returns the events the machine will actually honor right now, with their payload schemas.                                                                                                     |
| Persistence           | A configured checkpointer (`MemorySaver`, Postgres, Redis, SQLite) plus a thread registry, wired at `compile()`.                                                                                                                      | Two independent choices: persist the JSON snapshot yourself, or append the [event log](event-log.md). SQLite stores ship; neither is required to pause.                                                                     |
| Replay / determinism  | `getStateHistory` plus replay and fork from a checkpoint. Replay re-executes nodes after the chosen checkpoint, including model calls.                                                                                                | The log of external inputs is the source of truth. `replay` folds it back through pure transitions with no model calls, and each entry carries `stateHash` / `effectsHash` so a divergent replay is detectable, not silent. |
| Typing                | Good: state types derive from `StateSchema`, and `GraphNode` / `ConditionalEdgeRouter` are typed. The `interrupt()` return value is untyped and needs a cast.                                                                         | Context, input, output, event payloads, and each request's input/output are Standard Schemas. Event names in `allowedEvents` and transition targets are checked at compile time; resume events are schema-validated.        |
| Visualization         | `graph.getGraphAsync()` renders Mermaid or PNG. LangGraph Studio gives a live debugger.                                                                                                                                               | The machine is plain data: `getJsonSchema`, structural hashing, and any XState tool, including the Stately editor and inspector. See [Machines as data](machines-as-data.md).                                               |
| Model coupling        | Nodes call LangChain model objects directly; the graph and the provider are one artifact.                                                                                                                                             | The machine names a model ref and never calls a provider. [Executors](hosts.md) resolve it, so the same machine runs against the AI SDK, Workers AI, or raw `fetch`.                                                        |
| Offline verification  | Testing a branch generally means running the graph, with the model stubbed by hand.                                                                                                                                                   | `lintAgentMachine`, `canReach`, `explorePaths`, and `simulateAgent` check reachability, dead states, and scripted playthroughs with no API key and no network. See [Testing and verification](verify.md).                   |
| Ecosystem maturity    | **Clearly ahead.** Years of production use, LangSmith tracing and evals, LangGraph Platform deployment, prebuilt agents and middleware, hundreds of LangChain integrations, a large body of tutorials, and a Python twin with parity. | Alpha. One core dependency (XState v6 alpha), a small shipped executor set, SQLite stores, and a runnable examples directory. No hosted platform, no eval product.                                                          |

## LangGraph strengths

Pick LangGraph when these matter more than machine-enforced control flow:

- **You want the platform, not just the library.** LangSmith (LangChain's hosted tracing, dataset, and eval product) plus LangGraph Platform for deployment and thread management are real products you would otherwise build.
- **You are already in LangChain.** Hundreds of integrations, retrievers, and tool wrappers work out of the box, and `createAgent` gets a competent tool-calling agent running in minutes.
- **Python and JS need parity.** LangGraph ships both with matching concepts. This library is TypeScript only.
- **Your team already knows it.** Node/edge/checkpoint is a shared vocabulary with a lot of published prior art.
- **The workflow is mostly linear or mostly free-form.** If control flow is a short pipeline, or if you genuinely want the model to drive with few constraints, a statechart is overhead without much payoff.
- **You need production maturity today.** `@statelyai/agent` 2.0 is alpha and its APIs can still change.

## Agent machine strengths

- **Constraints must hold regardless of the prompt.** Spend limits, approval gates, retry budgets, ordering rules.
- **Pausing should not require infrastructure.** Idle plus a JSON snapshot works in a Lambda, a queue worker, or a test.
- **You need to prove behavior before shipping.** Reachability, dead-state, and scripted playthrough checks run in CI without a model.
- **Replay has to be trustworthy.** Folding an event log through pure transitions reproduces a run exactly, with hashes that catch divergence.
- **The workflow is genuinely stateful.** Nested and parallel regions, states that mean something to the business, and a diagram non-engineers can read.
- **You want provider independence.** The machine has no SDK dependency, so swapping hosts does not touch the agent.

## Ported examples

Several LangGraph tutorials and how-tos exist here as runnable examples, so you can read the same problem in both shapes. Full list in [examples/README.md](../examples/README.md).

- [`corrective-rag`](../examples/corrective-rag/index.ts): the CRAG tutorial as explicit states (retrieve, grade, rewrite query, web-search fallback, grounded generate).
- [`adaptive-rag`](../examples/adaptive-rag/index.ts): route local vs web, grade retrieval and generation, bounded rewrite.
- [`reflection-writer`](../examples/reflection-writer/index.ts): the reflection essay-writer, generate and critique with a typed revision bound.
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

- [Quickstart](quickstart.md): install and run one machine end to end.
- [Thinking in state machines](thinking-in-state-machines.md): naming the states hiding in an agent loop.
- [Migrating from a hand-rolled loop](from-a-loop.md): the same conversion starting from `while`-loop code.
- [Human in the loop](human-in-the-loop.md): the idle-and-resume model in depth.
- [The event log](event-log.md): verified replay, forking, and the SQLite stores.
- [Testing and verification](verify.md): what you can check before a model runs.
