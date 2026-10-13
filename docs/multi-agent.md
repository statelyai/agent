# Multi-agent composition

Multi-agent systems are ordinary XState actor composition.

## Subgraphs

A LangGraph subgraph maps to one of two XState constructs, depending on whether it shares the parent's state keys.

### Shared state: nested compound state

A subgraph that reads and writes the parent's state keys is a nested compound state. It uses the same `context`, is entered through its `initial` child, and is left by a transition or by `onDone` when a nested `type: "final"` state is reached. No state transformation is needed.

```ts
import { z } from "zod";
import { setupAgent } from "@statelyai/agent";

const agent = setupAgent({
  context: z.object({ cart: z.array(z.string()), address: z.string().nullable() }),
  events: { SET_ADDRESS: z.object({ address: z.string() }), CONFIRM: z.object({}) },
});

const checkoutMachine = agent.createMachine({
  context: { cart: ["mug"], address: null },
  initial: "review",
  states: {
    // The subgraph: substates over the parent's own context.
    review: {
      initial: "editingAddress",
      states: {
        editingAddress: {
          on: {
            SET_ADDRESS: ({ event }) => ({
              target: "confirming",
              context: { address: event.address },
            }),
          },
        },
        confirming: { on: { CONFIRM: { target: "confirmed" } } },
        confirmed: { type: "final" },
      },
      onDone: { target: "paying" },
    },
    paying: {},
  },
});
```

### Own schema: invoked child machine

A subgraph with its own state schema is an invoked child machine. Register it under `actors` and invoke it from a state. The input/output mapping is explicit:

- `invoke.input` projects parent context into the child's declared `input`.
- `onDone` maps the child's typed `output` back into a parent context patch.

```ts
import { z } from "zod";
import { setupAgent } from "@statelyai/agent";

// The subgraph: its own context, input, and output.
const researchSetup = setupAgent({
  models,
  context: z.object({ topic: z.string(), notes: z.array(z.string()) }),
  input: z.object({ topic: z.string(), priorNotes: z.array(z.string()) }),
  output: z.object({ research: z.string() }),
  requests: {
    search: {
      model: "quick",
      schemas: { input: z.object({ topic: z.string() }), output: z.string() },
      prompt: ({ input }) => `Find sources about ${input.topic}.`,
    },
  },
});

const researchTeam = researchSetup.createMachine({
  context: ({ input }) => ({ topic: input.topic, notes: [...input.priorNotes] }),
  output: ({ context }) => ({ research: context.notes.join("\n") }),
  initial: "searching",
  states: {
    searching: {
      invoke: {
        src: "search",
        input: ({ context }) => ({ topic: context.topic }),
        onDone: ({ context, output }) => ({
          target: "done",
          context: { notes: [...context.notes, output.result] },
        }),
      },
    },
    done: { type: "final" },
  },
});

// The parent graph, with a different schema.
const coordinatorSetup = setupAgent({
  context: z.object({ topic: z.string(), research: z.string().nullable() }),
  input: z.object({ topic: z.string() }),
  actors: { researchTeam },
});

const coordinator = coordinatorSetup.createMachine({
  context: ({ input }) => ({ topic: input.topic, research: null }),
  initial: "researching",
  states: {
    researching: {
      invoke: {
        src: "researchTeam",
        // Input mapping: parent context to the child's declared input.
        input: ({ context }) => ({ topic: context.topic, priorNotes: [] }),
        // Output mapping: the child's output to a parent context patch.
        onDone: ({ output }) => ({ target: "writing", context: { research: output.research } }),
      },
    },
    writing: {},
  },
});
```

The child's `context` is private. The parent sees only what the child's `output` returns.

### When to nest, when to invoke

| The subgraph has                                                                    | Use                                    |
| ----------------------------------------------------------------------------------- | -------------------------------------- |
| Its own schema, its own budget, reuse across parents, or several parallel instances | Invoked child machine (`actors` entry) |
| None of these                                                                       | Nested compound state                  |

[Hierarchical teams](../examples/hierarchical-teams) invokes a research team and a writing team as child machines, each with its own budget and a typed output. [Agent supervisor](../examples/agent-supervisor) invokes each worker as a child machine and records its output in `onDone`.

## Child machines

Register a child machine under `actors`, invoke it from a state, and handle its typed output with `onDone`. `runToQuiescence` recursively binds Agent request actors in registered child machines.

## Long-lived actors

Invoke an agent machine at a parent state when it must survive transitions among nested substates. Send it events with XState's `sendTo`; receive outputs or emitted events through normal XState channels.

## Parallel teams

Use parallel states when the branch topology is known in the artifact. Use spawned actors when it is dynamic. Generic fan-out, child collection, actor identity, and persistence belong to XState rather than an Agent-specific abstraction.

## Collecting dynamic children

Spawned children are named at runtime, so the machine's event union cannot name their done events. Handle the canonical `xstate.done.actor` event and branch on `actorId`. `DoneActorEventOf<TLogic, TId?>` types that handler against the child's own output, which is XState's `DoneActorEvent` applied to the logic's `OutputFrom`.

```ts no-check
"xstate.done.actor": ({ context, event }) => {
  const { actorId, output } = event as DoneActorEventOf<typeof researchLogic>;
  if (!actorId.startsWith("research-")) return undefined;
  return { context: { findings: { ...context.findings, [actorId]: output.finding } } };
}
```

See [hierarchical teams](../examples/hierarchical-teams), [swarm handoff](../examples/swarm-handoff), [deep research](../examples/deep-research), and [game loop agent](../examples/game-loop-agent).
