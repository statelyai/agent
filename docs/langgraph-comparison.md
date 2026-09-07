---
title: Coming from LangGraph
description: A construct-by-construct map from a LangGraph StateGraph to an agent machine, with one worked node.
---

> **Alpha:** `@statelyai/agent` 2.0 is in alpha. APIs can change between releases; pin an exact version. Feedback: [github.com/statelyai/agent](https://github.com/statelyai/agent/issues).

Both libraries represent agent control flow explicitly. Stately Agent uses XState directly instead of introducing a second graph runtime.

## Construct map

| LangGraph concept                     | Stately Agent / XState                                                                                    |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `StateGraph`                          | XState machine                                                                                              |
| Node                                  | State, invoked actor, or action                                                                             |
| Tool/model node                       | Named Agent request actor                                                                                   |
| Plain (non-model) node                | An ordinary XState actor, usually `createAsyncLogic({ schemas, run })`                                       |
| `START` / `END`                       | `initial` on the machine; a `type: 'final'` state whose `output` is the run's typed result                   |
| Conditional edge, a pure function of state | A [`type: 'choice'` state](machines.md#choice-states)                                                   |
| Conditional edge, a response to an event | A guarded [transition](machines.md#transitions); when the model picks the branch, `agent.decide` with `allowedEvents` |
| `Annotation` reducer                  | No reducers. A transition returns a partial `context` patch, so the merge is written where the change happens |
| `withStructuredOutput(schema)`        | `schemas: { output }` on the request; the parsed value arrives as the invoke's `onDone` output                |
| Interrupt                             | A resting state that settles `runAgent` as idle. See [Human in the loop](human-in-the-loop.md)               |
| `new Command({ resume })`             | A typed machine event: `runAgent(machine, { snapshot, event })`, or `{ events, event }` from the log         |
| Checkpointer                          | A persisted XState snapshot the host stores. See [Persistence](persistence.md)                               |
| `config.configurable.thread_id`       | `runAgent(machine, { store, threadId })`, which reads and appends the thread's [event log](event-log.md)      |
| Stream events                         | `runAgentStream` plus XState inspection                                                                      |
| Subgraph                              | Invoked child machine                                                                                        |

Stately Agent does not ship a checkpointer or event-log backend. `store` is an interface; the built-in implementation is in-memory, and a host implements it over its own database. Use the storage, retry, and interruption semantics of the framework hosting XState.

## One node, before and after

A grading node routes to `generate` or `rewriteQuery`, and counts rewrites. In LangGraph the routing is a function that returns a node name, and the count is an `Annotation` reducer.

```ts no-check
const GraphState = Annotation.Root({
  grade: Annotation<"relevant" | "irrelevant" | null>({ reducer: (_l, r) => r, default: () => null }),
  attempts: Annotation<number>({ reducer: (l, r) => l + r, default: () => 0 }),
});

async function grade(state: typeof GraphState.State) {
  const grader = model.withStructuredOutput(gradeSchema, { name: "grade" });
  const result = await grader.invoke([{ role: "user", content: state.question }]);
  return { grade: result.grade };
}

function routeAfterGrade(state: typeof GraphState.State) {
  if (state.grade === "relevant" || state.attempts >= 2) return "generate";
  return "rewriteQuery";
}

const workflow = new StateGraph(GraphState)
  .addNode("grade", grade)
  .addConditionalEdges("grade", routeAfterGrade, { generate: "generate", rewriteQuery: "rewriteQuery" })
  .addEdge("rewriteQuery", "retrieve");
```

The machine names the same three things: the model call is a request, the routing is a state, and the counter is a patch on the transition that causes it.

```ts
import { z } from "zod";
import { setupAgent } from "@statelyai/agent";

const gradeSchema = z.object({ grade: z.enum(["relevant", "irrelevant"]), reason: z.string() });

const agentSetup = setupAgent({
  models,
  context: z.object({
    question: z.string(),
    docs: z.array(z.string()),
    grade: z.enum(["relevant", "irrelevant"]).nullable(),
    attempts: z.number(),
  }),
  input: z.object({ question: z.string() }),
  output: z.object({ answer: z.string().nullable() }),
  requests: {
    gradeDocs: {
      model: "quick",
      schemas: {
        input: z.object({ question: z.string(), docs: z.array(z.string()) }),
        output: gradeSchema, // withStructuredOutput
      },
      system: "Grade whether the documents answer the question.",
      prompt: ({ input }) => `Q: ${input.question}\n\n${input.docs.join("\n---\n")}`,
    },
    rewriteQuery: {
      model: "quick",
      schemas: { input: z.object({ question: z.string() }), output: z.string() },
      system: "Rewrite the question to retrieve better documents.",
      prompt: ({ input }) => input.question,
    },
  },
});

const machine = agentSetup.createMachine({
  context: ({ input }) => ({ question: input.question, docs: [], grade: null, attempts: 0 }),
  initial: "grading", // START
  states: {
    grading: {
      invoke: {
        src: "gradeDocs",
        input: ({ context }) => ({ question: context.question, docs: context.docs }),
        onDone: ({ output }) => ({ target: "routing", context: { grade: output.grade } }),
      },
    },
    // addConditionalEdges: a routing branch with no event and no side effect.
    routing: {
      type: "choice",
      choice: ({ context }) =>
        context.grade === "relevant" || context.attempts >= 2
          ? { target: "generating" }
          : { target: "rewriting" },
    },
    rewriting: {
      invoke: {
        src: "rewriteQuery",
        input: ({ context }) => ({ question: context.question }),
        // The `attempts` reducer, written on the transition that increments it.
        onDone: ({ context, output }) => ({
          target: "retrieving",
          context: { question: output, attempts: context.attempts + 1 },
        }),
      },
    },
    // ...
  },
});
```

The differences worth planning for:

- **Merges are explicit.** LangGraph merges every node's return value through the channel's reducer. A machine transition returns the fields it changes, and omitted fields keep their values. There is nowhere for a reducer to live, so a running total is written as `attempts: context.attempts + 1` on the transition.
- **Routing is a state or a transition, not a return value.** A pure function of state is a `choice` state. A branch taken in response to something arriving is a guarded transition on an event. A branch the model picks is `agent.decide` with `allowedEvents`, and the machine rejects a choice the current state does not accept.
- **Resume is typed.** `Command({ resume })` carries an opaque value back into the interrupted node. Resuming a machine sends one of its declared events, and `parseAgentEvent` checks the payload at the boundary before anything runs. An event the state does not handle is ignored, the way a state machine always ignores one. See [Human in the loop](human-in-the-loop.md).

## Worked examples

- [corrective-rag](../examples/corrective-rag/index.ts) ports LangGraph's canonical corrective-RAG graph. Its header maps every node and edge, and it folds the conditional edge into the grader's own `onDone` instead of a separate `choice` state.
- [Human in the loop](human-in-the-loop.md) covers `interrupt` and `Command({ resume })`: `meta.interaction`, idle settling, `eventFromInteraction`, and resuming from a snapshot.
- [Persistence](persistence.md) covers the checkpointer and `thread_id`: the event log, `store`, `threadId`, and host-owned `persist()`.
- [Migrating from a hand-rolled loop](from-a-loop.md) covers the same conversion from a `while` loop.

A machine can run with `runAgent`, an application-owned XState actor, a pure `initialTransition` / `transition` loop, or XState's durable runtime. The artifact does not change. See [Choosing a run mode](choosing-a-run-mode.md).
