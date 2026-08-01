---
title: LangGraph vs agent machines
description: The same draft-review-revise agent built twice, in LangGraph JS and in @statelyai/agent, with an honest dimension-by-dimension comparison.
---

> **Alpha:** `@statelyai/agent` 2.0 is in alpha. APIs can change between releases; pin an exact version. Feedback: [github.com/statelyai/agent](https://github.com/statelyai/agent/issues).

[LangGraph](https://docs.langchain.com/oss/javascript/langgraph) and `@statelyai/agent` solve overlapping problems: both give an LLM workflow explicit structure, both pause for humans, both persist and resume. They disagree about where control flow lives.

This page builds one small agent in both, then compares them dimension by dimension. If you want a term-by-term translation table instead, read [Coming from LangGraph](from-langgraph.md).

Code blocks are illustrative and not typechecked in this repo. LangGraph snippets target `@langchain/langgraph` 1.x.

## The agent

An email assistant with a human gate:

1. Draft an email from a request.
2. Stop and show the draft to a human.
3. Approve sends it; revise loops back to drafting with feedback.
4. At most 3 revisions, then it must be approved or dropped.

Same four moving parts in both: a model call, a pause, a loop, and a bound on the loop.

## In LangGraph

```ts
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

## Dimension by dimension

| Dimension | LangGraph | `@statelyai/agent` |
| --- | --- | --- |
| Graph definition | `new StateGraph(State)` with `addNode` / `addEdge` / `addConditionalEdges`, compiled to a Pregel runtime. | `setupAgent(...).createMachine(...)`: a statechart with nested and parallel states, entry/exit actions, and invoked actors. |
| Control-flow legality | A conditional router is a function returning a node name; `Command({ goto })` can also jump from inside a node. Bounds like "max 3 revisions" are `if`s the runtime does not enforce. | Transitions are declared per state. A guard returning `undefined` makes the transition illegal, and `snapshot.can(event)` is checked before anything is applied. Illegal paths are not authorable. |
| Model-chosen branches | A node returns a literal that the router matches on. Parsing and validating the model's answer is your code. | `agent.decide` offers the model only the events the current state accepts, intersected with `allowedEvents`. An illegal or guard-rejected pick is recorded as a typed attempt and re-asked. See [Decisions](decisions.md). |
| State | Channels declared with `StateSchema`, merged by reducers (`ReducedValue`, `MessagesValue`). Nodes return partial updates. | A single typed `context` object, updated by transition functions returning partial context. A reducer becomes an ordinary function of `{ context, event }`. |
| Human in the loop | `interrupt(payload)` inside a node, resumed with `Command({ resume })`. Requires a checkpointer and a `thread_id`; the interrupting node re-executes from the top on resume. | A state with no invoke. `runAgent` settles `idle` and hands back a JSON snapshot. No runtime primitive, no checkpointer requirement, and nothing re-executes. See [Human in the loop](human-in-the-loop.md). |
| Rendering the choices | The `interrupt` payload is whatever you passed; the UI's option list is prose you keep in sync by hand. | `getAcceptedEvents(snapshot)` returns the events the machine will actually honor right now, with their payload schemas. |
| Persistence | A configured checkpointer (`MemorySaver`, Postgres, Redis, SQLite) plus a thread registry, wired at `compile()`. | Two independent choices: persist the JSON snapshot yourself, or append the [event log](event-log.md). SQLite stores ship; neither is required to pause. |
| Replay / determinism | `getStateHistory` plus replay and fork from a checkpoint. Replay re-executes nodes after the chosen checkpoint, including model calls. | The log of external inputs is the source of truth. `replay` folds it back through pure transitions with no model calls, and each entry carries `stateHash` / `effectsHash` so a divergent replay is detectable, not silent. |
| Typing | Good: state types derive from `StateSchema`, and `GraphNode` / `ConditionalEdgeRouter` are typed. The `interrupt()` return value is untyped and needs a cast. | Context, input, output, event payloads, and each request's input/output are Standard Schemas. Event names in `allowedEvents` and transition targets are checked at compile time; resume events are schema-validated. |
| Visualization | `graph.getGraphAsync()` renders Mermaid or PNG. LangGraph Studio gives a live debugger. | The machine is plain data: `getJsonSchema`, structural hashing, and any XState tool, including the Stately editor and inspector. See [Machines as data](machines-as-data.md). |
| Model coupling | Nodes call LangChain model objects directly; the graph and the provider are one artifact. | The machine names a model ref and never calls a provider. [Executors](hosts.md) resolve it, so the same machine runs against the AI SDK, Workers AI, or raw `fetch`. |
| Offline verification | Testing a branch generally means running the graph, with the model stubbed by hand. | `lintAgentMachine`, `canReach`, `explorePaths`, and `simulateAgent` check reachability, dead states, and scripted playthroughs with no API key and no network. See [Testing and verification](verify.md). |
| Ecosystem maturity | **Clearly ahead.** Years of production use, LangSmith tracing and evals, LangGraph Platform deployment, prebuilt agents and middleware, hundreds of LangChain integrations, a large body of tutorials, and a Python twin with parity. | Alpha. One core dependency (XState v6 alpha), a small shipped executor set, SQLite stores, and a runnable examples directory. No hosted platform, no eval product. |

## When to prefer LangGraph

Pick LangGraph when these matter more than machine-enforced control flow:

- **You want the platform, not just the library.** LangSmith tracing, datasets, and evals, plus LangGraph Platform for deployment and thread management, are real products you would otherwise build.
- **You are already in LangChain.** Hundreds of integrations, retrievers, and tool wrappers work out of the box, and `createAgent` gets a competent tool-calling agent running in minutes.
- **Python and JS need parity.** LangGraph ships both with matching concepts. This library is TypeScript only.
- **Your team already knows it.** Node/edge/checkpoint is a shared vocabulary with a lot of published prior art.
- **The workflow is mostly linear or mostly free-form.** If control flow is a short pipeline, or if you genuinely want the model to drive with few constraints, a statechart is overhead without much payoff.
- **You need production maturity today.** `@statelyai/agent` 2.0 is alpha and its APIs can still change.

## When to prefer agent machines

- **Constraints must hold regardless of the prompt.** Spend limits, approval gates, retry budgets, ordering rules. A guard cannot be talked around; an `if` in a router node is only as good as the code path that reaches it.
- **Pausing should not require infrastructure.** Idle plus a JSON snapshot works in a Lambda, a queue worker, or a test, with no checkpointer configured.
- **You need to prove behavior before shipping.** Reachability, dead-state, and scripted playthrough checks run in CI without a model.
- **Replay has to be trustworthy.** Folding an event log through pure transitions reproduces a run exactly, with hashes that catch divergence.
- **The workflow is genuinely stateful.** Nested and parallel regions, states that mean something to the business, and a diagram non-engineers can read.
- **You want provider independence.** The machine has no SDK dependency, so swapping hosts does not touch the agent.

## Where to go next

- [Coming from LangGraph](from-langgraph.md): the full term-by-term mapping and the ported tutorial examples.
- [Quickstart](quickstart.md): install and run one machine end to end.
- [Human in the loop](human-in-the-loop.md): the idle-and-resume model in depth.
- [The event log](event-log.md): verified replay, forking, and the SQLite stores.
- [Testing and verification](verify.md): what you can check before a model runs.
