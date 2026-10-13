# Agent patterns

The examples are non-trivial state machines, not special runner APIs.

## Control-flow patterns

- [Evaluator/optimizer](../examples/ai-sdk-evaluator-optimizer)
- [Validate and repair](validate-and-repair.md) ([example](../examples/generate-and-repair))
- [Reflection writer](../examples/reflection-writer)
- [Plan and execute](../examples/plan-and-execute)
- [Corrective RAG](../examples/corrective-rag)
- [Deep research](../examples/deep-research)
- [Guardrails](../examples/guardrails)
- [Hierarchical teams](../examples/hierarchical-teams)
- [Swarm handoff](../examples/swarm-handoff)
- [Parallel streams](../examples/parallel-streams)

## Human and long-running patterns

- [Long-running onboarding](../examples/long-running-onboarding)
- [Snapshot migration](../examples/snapshot-migration)
- [Review tool calls](../examples/review-tool-calls)
- [SQL approval](../examples/sql-agent)
- [Context compaction](../examples/context-compaction)
- [Statechart policy examples](statechart-policy-examples.md): reviewer quorum, booking compensation, and scheduler-driven approval deadlines

### Long-term memory

Memory that outlives a run lives in a store the host owns (see [Scope](scope.md#ownership-boundary)). The machine reads and writes it through actors:

- The store is host-owned. The host picks the backend: a key-value store, a vector index, or SQL.
- Recall is an `actors` entry invoked from a state, so what the model was shown is in the request input.
- Save is two steps: a pure `choice` state caps and filters the new facts, then an actor writes them.
- Context holds handles and small results (`userId`, the recalled facts), not the store's contents.

```ts
import { z } from "zod";
import { createAsyncLogic } from "xstate";
import { setupAgent } from "@statelyai/agent";

const RECALL_LIMIT = 3;
const MAX_SAVES = 2;

// The host's store: a key-value store, a vector index, or SQL behind two calls.
interface MemoryStore {
  search(userId: string, query: string, limit: number): Promise<string[]>;
  put(userId: string, facts: string[]): Promise<void>;
}
declare const store: MemoryStore;

const recallMemories = createAsyncLogic<string[], { userId: string; message: string }>({
  run: ({ input }) => store.search(input.userId, input.message, RECALL_LIMIT),
});
const saveMemories = createAsyncLogic<void, { userId: string; facts: string[] }>({
  run: ({ input }) => store.put(input.userId, input.facts),
});

const agent = setupAgent({
  models,
  context: z.object({
    userId: z.string(),
    message: z.string(),
    recalled: z.array(z.string()),
    reply: z.string(),
    newFacts: z.array(z.string()),
  }),
  input: z.object({ userId: z.string(), message: z.string() }),
  output: z.object({ reply: z.string() }),
  actors: { recallMemories, saveMemories },
  requests: {
    answer: {
      model: "quick",
      schemas: {
        input: z.object({ message: z.string(), recalled: z.array(z.string()) }),
        output: z.object({ reply: z.string(), newFacts: z.array(z.string()) }),
      },
      system: "Answer the user. List new facts about the user worth remembering.",
      prompt: ({ input }) => `Known facts:\n${input.recalled.join("\n")}\n\n${input.message}`,
    },
  },
});

const memoryMachine = agent.createMachine({
  context: ({ input }) => ({ ...input, recalled: [], reply: "", newFacts: [] }),
  output: ({ context }) => ({ reply: context.reply }),
  initial: "recalling",
  states: {
    recalling: {
      invoke: {
        src: "recallMemories",
        input: ({ context }) => ({ userId: context.userId, message: context.message }),
        onDone: ({ output }) => ({ target: "answering", context: { recalled: output } }),
      },
    },
    answering: {
      invoke: {
        src: "answer",
        input: ({ context }) => ({ message: context.message, recalled: context.recalled }),
        onDone: ({ output }) => ({ target: "savingMemories", context: output.result }),
      },
    },
    // Pure: drop facts already recalled, cap the rest.
    savingMemories: {
      type: "choice",
      choice: ({ context }) => {
        const facts = context.newFacts
          .filter((fact) => !context.recalled.includes(fact))
          .slice(0, MAX_SAVES);
        return facts.length === 0
          ? { target: "done" }
          : { target: "writing", context: { newFacts: facts } };
      },
    },
    writing: {
      invoke: {
        src: "saveMemories",
        input: ({ context }) => ({ userId: context.userId, facts: context.newFacts }),
        onDone: { target: "done" },
      },
    },
    done: { type: "final" },
  },
});
```

To swap the store per run without rebuilding the machine, pass the actors to the runtime: `createAgentRuntime(memoryMachine, { actors: { recallMemories, saveMemories } })` merges them over the registered ones.

[Long-term memory](../examples/long-term-memory) ports LangGraph's memory agent. Its recall is a judgment over the user's memories, and its save state caps the store at `MAX_MEMORIES`. It passes the whole store in as machine input and returns it as output, which fits a store of a few dozen facts. A larger store stays behind actors as above.

## Host portability

The same machine artifact runs through AI SDK, Anthropic, OpenAI, LangChain, Mastra, Cloudflare, Next.js, or plain XState examples. Host adapters supply requests; they do not redefine agent control flow.

Generic orchestration such as fan-out remains ordinary XState composition.
