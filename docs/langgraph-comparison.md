---
title: Coming from LangGraph
description: A construct-by-construct map from a LangGraph StateGraph to an agent machine, with one worked node.
---

> **Alpha:** `@statelyai/agent` 2.0 is in alpha. APIs can change between releases; pin an exact version. Feedback: [github.com/statelyai/agent](https://github.com/statelyai/agent/issues).

Both libraries represent agent control flow explicitly. Stately Agent uses XState directly instead of introducing a second graph runtime.

## Construct map

| LangGraph concept                          | Stately Agent / XState                                                                                                                  |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `StateGraph`                               | XState machine                                                                                                                          |
| Node                                       | State, invoked actor, or action                                                                                                         |
| Tool/model node                            | Named Agent request actor                                                                                                               |
| Grader / classifier node                   | An actor calling the AI SDK's `experimental_evaluate` with Jev via `@ai-sdk/typesafe-ai` ([judgments](judgments.md))                    |
| Plain (non-model) node                     | An ordinary XState actor, usually `createAsyncLogic({ schemas, run })`                                                                  |
| `START` / `END`                            | `initial` on the machine; a `type: 'final'` state whose `output` is the run's typed result                                              |
| Conditional edge, a pure function of state | A [`type: 'choice'` state](machines.md#choice-states)                                                                                   |
| Conditional edge, a response to an event   | A guarded [transition](machines.md#transitions); when the model picks the branch, `agent.decide` with `allowedEvents`                   |
| `Annotation` reducer                       | No reducers. A transition returns a partial `context` patch, so the merge is written where the change happens                           |
| `withStructuredOutput(schema)`             | `schemas: { output }` on the request; the parsed value arrives as `output.result` in the invoke's `onDone`                              |
| Interrupt                                  | A resting state that settles `runToQuiescence` as idle. See [Human in the loop](human-in-the-loop.md)                                   |
| `new Command({ resume })`                  | A typed machine event: `runToQuiescence(createAgentRuntime(machine, {}), { snapshot, event })`, or `{ events, event }` from the log     |
| Checkpointer                               | A persisted XState snapshot the host stores. See [Persistence](persistence.md)                                                          |
| `config.configurable.thread_id`            | `runToQuiescence(createAgentRuntime(machine, { store, threadId }), {})`, which reads and appends the thread's [event log](event-log.md) |
| Stream events                              | `onTrace` (`stream.chunk`) plus XState inspection                                                                                       |
| Subgraph                                   | Invoked child machine                                                                                                                   |

Stately Agent does not ship a checkpointer or event-log backend. `store` is an interface; the built-in implementation is in-memory, and a host implements it over its own database. Use the storage, retry, and interruption semantics of the framework hosting XState.

## One node, before and after

A grading node routes to `generate` or `rewriteQuery`, and counts rewrites. In LangGraph the routing is a function that returns a node name, and the count is an `Annotation` reducer.

```ts no-check
const GraphState = Annotation.Root({
  grade: Annotation<"relevant" | "irrelevant" | null>({
    reducer: (_l, r) => r,
    default: () => null,
  }),
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
  .addConditionalEdges("grade", routeAfterGrade, {
    generate: "generate",
    rewriteQuery: "rewriteQuery",
  })
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
        onDone: ({ output }) => ({ target: "routing", context: { grade: output.result.grade } }),
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
          context: { question: output.result, attempts: context.attempts + 1 },
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
- [Ported LangGraph examples](#ported-langgraph-examples) below lists every LangGraph tutorial, template, and community example ported to `examples/`. Each file's header comment maps the graph's nodes and edges to machine states.
- [Human in the loop](human-in-the-loop.md) covers `interrupt` and `Command({ resume })`: `meta.interaction`, idle settling, `eventFromInteraction`, and resuming from a snapshot.
- [Persistence](persistence.md) covers the checkpointer and `thread_id`: the event log, `store`, `threadId`, and host-owned `persist()`.
- [Migrating from a hand-rolled loop](from-a-loop.md) covers the same conversion from a `while` loop.

A machine can run with `runToQuiescence`, an application-owned XState actor, a pure `initialTransition` / `transition` loop, or XState's durable runtime. The artifact does not change. See [Choosing a run mode](choosing-a-run-mode.md).

## Ported LangGraph examples

Every example below runs in the demo and has a test that scripts the model by request name. Classification, grading, relevance, and yes/no steps are [judgments](judgments.md) made with the AI SDK's `experimental_evaluate` and Jev via `@ai-sdk/typesafe-ai`, not text requests; live services (web search, vector stores, sandboxes) are replaced by small in-file sample data, labelled as such in the code. The right column names the construct the machine makes structural where the LangGraph version leaves it to a prompt or to `recursion_limit`.

| LangGraph source                            | Example                                                                       | What the machine makes structural                                               |
| ------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Corrective RAG (CRAG)                       | [corrective-rag](../examples/corrective-rag/index.ts)                         | the grade-then-branch choice, one acyclic correction pass                       |
| Adaptive RAG, Self-RAG                      | [adaptive-rag](../examples/adaptive-rag/index.ts)                             | route choice, then `MAX_REWRITES` and `MAX_REGENERATIONS` guards on both loops  |
| Agentic RAG                                 | [agentic-rag](../examples/agentic-rag/index.ts)                               | `agent.decide` over `RETRIEVE`/`ANSWER`, `RETRIEVE` rejected past the budget    |
| Code assistant (AlphaCodium)                | [code-assistant](../examples/code-assistant/index.ts)                         | a retry budget around code that really runs                                     |
| Plan-and-execute, ReWOO                     | [plan-and-execute](../examples/plan-and-execute/index.ts)                     | a step budget that ends in `failed`                                             |
| LLMCompiler                                 | [llm-compiler](../examples/llm-compiler/index.ts)                             | plan validated by a choice state; ready tasks spawned per wave                  |
| Reflection                                  | [reflection-writer](../examples/reflection-writer/index.ts)                   | a revision budget in context                                                    |
| Reflexion                                   | [reflexion](../examples/reflexion/index.ts)                                   | search-grounded critique, citations checked against retrieved passages          |
| Tree of Thoughts (Game of 24)               | [tree-of-thoughts](../examples/tree-of-thoughts/index.ts)                     | a hand-written scorer rejects illegal steps; `BEAM_SIZE` and `MAX_DEPTH`        |
| Self-Discover                               | [self-discover](../examples/self-discover/index.ts)                           | a choice state bounds the selected module count, with one retry                 |
| Multi-agent supervisor                      | [agent-supervisor](../examples/agent-supervisor/index.ts)                     | routing through `agent.decide` under per-worker and turn guards                 |
| Hierarchical agent teams                    | [hierarchical-teams](../examples/hierarchical-teams/index.ts)                 | child machines with their own budgets                                           |
| Swarm, multi-agent network                  | [swarm-handoff](../examples/swarm-handoff/index.ts)                           | `HANDOFF` under a guard; the active agent survives a snapshot                   |
| Map-reduce (`Send`), orchestrator-worker    | [map-reduce](../examples/map-reduce/index.ts)                                 | a spawned child per subject, reduced as they land, capped width                 |
| Prompt chaining                             | [prompt-chaining](../examples/prompt-chaining/index.ts)                       | the gate is a choice state over a pure check, with a bounded retry              |
| Parallelization                             | [parallel-streams](../examples/parallel-streams/index.ts)                     | two regions streaming at once                                                   |
| Routing                                     | [triage](../examples/triage/index.ts)                                         | structured classification with one retry                                        |
| Evaluator-optimizer                         | [ai-sdk-evaluator-optimizer](../examples/ai-sdk-evaluator-optimizer/index.ts) | explicit states with a strict critic gating the exit                            |
| Open Deep Research, local deep researcher   | [deep-research](../examples/deep-research/index.ts)                           | a researcher spawned per query, results reduced as they land                    |
| STORM                                       | [storm-writer](../examples/storm-writer/index.ts)                             | an interview child per editor with a turn cap                                   |
| TNT-LLM                                     | [tnt-llm](../examples/tnt-llm/index.ts)                                       | per-document summary children, then a batch index drives the taxonomy loop      |
| Data enrichment, company researcher         | [data-enrichment](../examples/data-enrichment/index.ts)                       | a choice state decides completeness; one `MAX_LOOPS` budget                     |
| Information gathering (prompt generation)   | [info-gathering](../examples/info-gathering/index.ts)                         | a choice state checks the requirement slots; `MAX_TURNS` idle turns             |
| Memory agent, semantic-search memory        | [long-term-memory](../examples/long-term-memory/index.ts)                     | the store is machine input and output; recall and a capped save are states      |
| Wait for user input, breakpoints            | [human-in-the-loop](../examples/human-in-the-loop/index.ts)                   | an idle review state with a bounded redraft loop                                |
| Review tool calls                           | [review-tool-calls](../examples/review-tool-calls/index.ts)                   | each proposed call gated behind `APPROVE`/`EDIT`/`REJECT`                       |
| Customer support (airline)                  | [customer-support](../examples/customer-support/index.ts)                     | sensitive actions routed into the approval gate                                 |
| SQL agent                                   | [sql-agent](../examples/sql-agent/index.ts)                                   | approval before the engine runs the query                                       |
| Summarize conversation history              | [context-compaction](../examples/context-compaction/index.ts)                 | an explicit `compacting` state                                                  |
| Chatbot simulation evaluation               | [chatbot-simulation-eval](../examples/chatbot-simulation-eval/index.ts)       | alternating turns under a `MAX_EXCHANGES` guard; the judge inside the machine   |
| Handle tool-calling errors (model fallback) | [model-fallback](../examples/model-fallback/index.ts)                         | a validator actor and a choice state escalate to a stronger model once          |
| Many tools (bigtool)                        | [tool-retrieval](../examples/tool-retrieval/index.ts)                         | a guard allows only the selected tools; call and reselection budgets            |
| Extraction with retries                     | [generate-and-repair](../examples/generate-and-repair/index.ts)               | a repair round the machine caps                                                 |
| Multi-agent debate (community)              | [multi-agent-debate](../examples/multi-agent-debate/index.ts)                 | turn order and round count as edges; `MAX_ROUNDS` in the input schema           |
| Essay grading system (community)            | [essay-grader](../examples/essay-grader/index.ts)                             | choice states over exported thresholds stop at the first weak pass              |
| Feynman-technique tutor (community)         | [feynman-tutor](../examples/feynman-tutor/index.ts)                           | an idle explain-back state per checkpoint; a re-teach budget                    |
| Project manager assistant (community)       | [project-planner](../examples/project-planner/index.ts)                       | the machine validates the graph and computes the critical path; a replan budget |

Not ported: examples that need a live browser or code sandbox (Web Voyager, USACO, CodeAct, Open SWE), and LATS, whose bounded tree search [tree-of-thoughts](../examples/tree-of-thoughts/index.ts) already shows.
