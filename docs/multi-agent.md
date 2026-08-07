---
title: Multi-agent composition
description: Compose agent machines today by invoking them as child actors, exposing sub-agents as host-owned tools, and coordinating siblings through events.
---

> **Alpha:** `@statelyai/agent` 2.0 is in alpha. APIs can change between releases; pin an exact version. Feedback: [github.com/statelyai/agent](https://github.com/statelyai/agent/issues).

An agent machine is an XState actor, so you compose agents with XState's existing actor patterns. No separate orchestration layer:

- invoke one machine from another as a **child actor**
- expose sub-agents as **host-owned tools**
- let sibling machines coordinate by **sending events**

The machine decides, the [host](hosts.md) executes. Composition changes which machine is deciding, not who talks to the model.

## Agent machines as child actors

<!-- child-actor composition from examples/subflows/index.ts -->

Register a child machine under `actors:` on the parent's `setupAgent(...)`, then invoke it by name. The parent treats the child like any other invoked actor: typed `input`, final output in `onDone`.

[examples/subflows/index.ts](../examples/subflows/index.ts) delegates a topic to a research child this way:

```ts
const parentSetup = setupAgent({
  context: z.object({ topic: z.string(), research: z.string().nullable() }),
  input: z.object({ topic: z.string() }),
  output: z.object({ research: z.string() }),
  actors: { child: childMachine },
});

const subflowsMachine = parentSetup.createMachine({
  context: ({ input }) => ({ topic: input.topic, research: null }),
  initial: "delegating",
  states: {
    delegating: {
      invoke: {
        id: "child",
        src: "child",
        input: ({ context }: { context: { topic: string } }) => ({ topic: context.topic }),
        onDone: ({ output }) => ({ target: "done", context: { research: output.research } }),
      },
    },
    done: { type: "final", output: ({ context }) => ({ research: context.research ?? "" }) },
  },
});
```

The child is its own `setupAgent(...)` agent (`{ topic } -> { research }`); its `researchTopic` request inherits the parent run's executors automatically, no per-child binding (see [executor inheritance](#executor-inheritance) below).

### Observing child actors

<!-- onTransition vs inspect/inspectTransitions from src/run-agent.ts -->

`runAgent` offers two ways to observe:

- **`onTransition`** fires for the **root** machine's transitions only. Use it for parent progress.
- **`inspect`** is the raw, system-wide stream (root, every invoked child, and spawned actors), so it is the only way to see a child's states. Attribute each event via `event.actorRef.id` (the invoke id) or `.src`.

The `inspectTransitions(handler)` helper wraps `inspect`: it filters to `@xstate.transition` events and hands the handler the typed snapshot and actorRef, replacing the manual `event.type === '@xstate.transition'` check and casts.

```ts
import { inspectTransitions, runAgent } from "@statelyai/agent";

await runAgent(parentMachine, {
  executors,
  onTransition: (snapshot) => console.log("parent:", snapshot.value),
  inspect: inspectTransitions((snapshot, actorRef) => {
    console.log(`[${actorRef.id}]`, snapshot.value); // child transitions included
  }),
});
```

[examples/subflows/index.ts](../examples/subflows/index.ts) contrasts the two channels side by side.

## Sub-agents as host-owned tools

<!-- host-owned sub-agent tools from examples/ai-sdk-sub-agents/index.ts -->

A sub-agent need not be a machine. Here the machine sees a single text request with tools; the host makes those tools delegate to worker agents built with another framework.

[examples/ai-sdk-sub-agents/index.ts](../examples/ai-sdk-sub-agents/index.ts) exposes `askResearcher` and `askWriter` tools whose `execute` calls a Vercel AI SDK `ToolLoopAgent` worker:

```ts no-check
requests: {
  supervise: {
    schemas: { input: taskInputSchema, output: answerSchema },
    model: 'supervisor',
    system: 'You are a supervisor. Use askResearcher for facts and askWriter for the final wording.',
    prompt: ({ input }) => input.task,
    tools: {
      askResearcher: {
        description: 'Ask the researcher sub-agent for notes.',
        inputSchema: z.object({ prompt: z.string() }),
        execute: createSubAgentExecute(subAgents, 'researcher'),
      },
      askWriter: { /* ...same shape, delegates to 'writer' */ },
    },
  },
},
```

The machine stays portable: delegation lives entirely on the host side of the boundary.

Beyond tools, the host can provide **any async actor**. The machine declares a named actor source; the host supplies its implementation. That actor can be a remote agent call, a queue round trip, or another framework's runtime. See [Hosts and executors](hosts.md).

## Sibling coordination through events

<!-- event-based sibling coordination from examples/debate-sub-agents/index.ts -->

A parent can invoke several child agents at once and pass messages between them, using each child's `on:` handlers as its inbox. [examples/debate-sub-agents/index.ts](../examples/debate-sub-agents/index.ts) runs a debate this way:

```ts no-check
invoke: [
  { id: 'affirmative', src: 'affirmative', input: ({ context }) => ({ stance: 'affirmative', question: context.question }) },
  { id: 'negative', src: 'negative', input: ({ context }) => ({ stance: 'negative', question: context.question }) },
],
initial: 'requesting',
states: {
  requesting: {
    always: ({ context, children }, enq) => {
      const turn = turnAt(context.transcript.length);
      enq.sendTo(children[turn.stance], {
        type: 'DEBATE.ARGUMENT_REQUESTED',
        round: turn.round,
        transcript: context.transcript,
      });
      return { target: 'awaiting' };
    },
  },
  // ...
},
```

Each debater idles until it receives `DEBATE.ARGUMENT_REQUESTED`, composes an argument, and sends `DEBATE.ARGUMENT_SUBMITTED` back. The parent appends to a shared transcript and requests the next turn. Machines share state only through the messages they send.

## Executor inheritance

<!-- nested executor inheritance from src/run-agent.ts and examples/subflows -->

`runAgent` rebinds the executors you pass (`generateText`/`streamText`/`decide`) onto every unbound agent request, **including requests inside invoked child machines, at any depth**.

- A child request inherits the same host-backed executors as the parent.
- It shares the run's `maxModelCalls` budget, `onTrace`, `onChunk`, and `onResult`.

One `executors: { generateText }` on `runAgent(parentMachine, ...)` covers the parent's requests and the child's.

The rules:

| Case                                                                       | Inherits? | Why                                                                             |
| -------------------------------------------------------------------------- | --------- | -------------------------------------------------------------------------------- |
| Request reached through a string-keyed source (invoke `src`, `actors`)     | Yes       | The default, at any depth. Cycles are handled                                   |
| Spawn of a registered source (`enq.spawn(actors.worker, ...)`)             | Yes       | `runAgent` binds the source before the machine starts                           |
| Request with its own executor (`.withExecutor`, `bindRequestExecutor`)     | No        | Explicit bindings win; the parent's executors are never called for it           |
| Logic object constructed inside an action                                  | No        | Unregistered, so neither `runAgent` nor `provideExecutors` can see it           |
| Direct-object child machine (`invoke: { src: childMachine }`)              | No        | No string-keyed source to replace. Register it under `actors` and invoke by name |

**Missing executors fail fast.** If a reachable request needs an executor kind you didn't pass (e.g. a child's `mode: 'stream'` request but no `streamText`), binding throws before any actor runs, naming the invoke chain and request `src`.

### Dynamic binding

This works even though the branch count is known only at runtime:

```ts no-check
const agentSetup = setupAgent({
  // `worker` is registered once; the host supplies its executor later.
  requests: { worker: workerRequest },
  // ...schemas
});

const machine = agentSetup.createMachine({
  // ...
  states: {
    fanningOut: {
      entry: ({ context, actors }, enq) => {
        context.jobs.forEach((job, index) => {
          enq.spawn(actors.worker, {
            id: `worker-${index}`,
            input: { job },
          });
        });
      },
    },
  },
});

await runAgent(machine, { executors: { generateText } });
```

`actors.worker` is the machine's current post-`provide` implementation. By the time the entry action runs, `runAgent` has replaced it with the host-bound worker. [The fan-out example](../examples/fan-out/index.ts) uses this exact shape.

This does **not** inherit:

```ts no-check
entry: ({ context }, enq) => {
  // A fresh unregistered logic object: neither binding API can discover it.
  enq.spawn(createTextLogic(workerConfig), { input: { job: context.job } });
};
```

Register the logic and spawn it through `actors`, as above. Use `.withExecutor(...)` only when that one logic should deliberately carry its own host execution.

### Child binding in uncontrolled mode

[Controlled and uncontrolled](any-stack.md#controlled-and-uncontrolled) covers the two ways a host binds executors. The one composition delta: `runAgent` recursively binds registered child machines, `provideExecutors` binds only the machine passed to it. In uncontrolled mode, bind each machine explicitly and replace the parent's child source with the bound child:

```ts
const boundChild = provideExecutors(childMachine, executors);
const boundParent = provideExecutors(parentMachine, executors, {
  actors: { child: boundChild },
});

createActor(boundParent, { input }).start();
```

Dynamic spawning is equivalent under both APIs when the spawned source is registered on the machine being bound. The difference is recursive traversal into child machines, not whether the branch count is static or dynamic.

## Fan-out

This alpha ships no dedicated fan-out primitive. Use XState dynamic spawn when each branch should be a visible child actor with independent progress and persisted identity:

```ts no-check
entry: ({ context, actors }, enq) => {
  context.jobs.forEach((job, index) => {
    enq.spawn(actors.worker, { id: `worker-${index}`, input: { job } });
  });
};
```

Use `Promise.all(...)` inside a host actor or tool when the branches are implementation detail and the machine only needs their combined result. See [fan-out](../examples/fan-out/index.ts) for visible dynamic branches and [deep research](../examples/deep-research/index.ts) for a larger planner-worker-reducer flow.

## Related

- [Agent patterns](patterns.md#multi-agent): the full list of sub-agent and multi-machine examples.
- [Use in any stack](any-stack.md#controlled-and-uncontrolled): controlled and uncontrolled hosts.
- [Hosts and executors](hosts.md): the executor contract children inherit.
- [Preset machines](machines-presets.md): `createSupervisorMachine` and `createHandoffMachine`.
