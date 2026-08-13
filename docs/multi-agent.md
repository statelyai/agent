---
title: Multi-agent composition
description: Compose agent machines today by invoking them as child actors, exposing sub-agents as host-owned tools, and coordinating siblings through events.
---

> **Alpha:** `@statelyai/agent` 2.0 is in alpha. APIs can change between releases; pin an exact version. Feedback: [github.com/statelyai/agent](https://github.com/statelyai/agent/issues).

This page covers how to compose several agent machines. An agent machine is an XState actor, so you use XState's existing actor patterns. There is no separate orchestration layer.

There are three patterns:

- Invoke one machine from another as a **child actor**.
- Expose sub-agents as **host-owned tools**.
- Let sibling machines coordinate by **sending events**.

Composition changes which machine makes decisions. The [host](hosts.md) still executes every model call. Executor inheritance applies to all three patterns, so it is covered first.

<!-- viz: three composition topologies side by side: parent invoking a child agent machine; one machine with host tools delegating to worker agents; a parent with two sibling children exchanging events -->

## Executor inheritance

<!-- nested executor inheritance from src/run-agent.ts and examples/subflows -->

`runAgent` rebinds the executors you pass (`generateText`, `streamText`, `decide`) onto every unbound agent request. This includes requests inside invoked child machines, at any depth.

- A child request inherits the same host-backed executors as the parent.
- It shares the run's `maxModelCalls` budget, `onTrace`, `onChunk`, and `onResult`.

A single `executors: { generateText }` on `runAgent(parentMachine, ...)` covers both the parent's requests and the child's.

How a child machine is referenced decides whether it inherits. Register the child under `actors` and invoke it by name, and its requests inherit. Pass the machine object inline as `invoke: { src: childMachine }`, and there is no string-keyed source for `runAgent` to replace, so its requests stay unbound.

Inheritance follows these rules:

| Case                                                                   | Inherits? | Why                                                                              |
| ---------------------------------------------------------------------- | --------- | -------------------------------------------------------------------------------- |
| Request reached through a string-keyed source (invoke `src`, `actors`) | Yes       | The default, at any depth. Cycles are handled                                    |
| Spawn of a registered source (`enq.spawn(actors.worker, ...)`)         | Yes       | `runAgent` binds the source before the machine starts                            |
| Request with its own executor (`.withExecutor`, `bindRequestExecutor`) | No        | Explicit bindings win; the parent's executors are never called for it            |
| Logic object constructed inside an action                              | No        | Unregistered, so neither `runAgent` nor `provideExecutors` can see it            |
| Direct-object child machine (`invoke: { src: childMachine }`)          | No        | No string-keyed source to replace. Register it under `actors` and invoke by name |

Missing executors fail fast. If a reachable request needs an executor kind you did not pass, such as a child's `mode: 'stream'` request when you passed no `streamText`, binding throws before any actor runs. The error names the invoke chain and the request `src`.

### Dynamic binding

Inheritance also works when the branch count is known only at runtime.

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

`actors.worker` is the machine's current implementation after `provide`. By the time the entry action runs, `runAgent` has replaced it with the host-bound worker. [The fan-out example](../examples/fan-out/index.ts) uses this shape.

The following does not inherit executors:

```ts no-check
entry: ({ context }, enq) => {
  // A fresh unregistered logic object: neither binding API can discover it.
  enq.spawn(createTextLogic(workerConfig), { input: { job: context.job } });
};
```

Register the logic and spawn it through `actors`, as shown earlier. Use `.withExecutor(...)` only when that one logic should carry its own host execution.

### Child binding in uncontrolled mode

Read about the two ways a host binds executors in [Controlled and uncontrolled](any-stack.md#controlled-and-uncontrolled). Inheritance works the same way in both. `provideExecutors` binds registered child machines recursively, exactly as `runAgent` does, and each child machine is bound with its own schemas. The rules in the table above apply unchanged, so a direct-object child still inherits nothing.

```ts
const boundParent = provideExecutors(parentMachine, executors);

createActor(boundParent, { input }).start();
```

Pass `options.actors` when you want to replace a child source with a specific implementation, such as a hand-bound child or a test double. `agent.userInput` is left unbound, so supply a handler through `options.actors` when the machine invokes it.

Dynamic spawning behaves the same under both APIs when the spawned source is registered on the machine being bound. The only difference is recursive traversal into child machines. Whether the branch count is static or dynamic does not matter.

## Agent machines as child actors

<!-- child-actor composition from examples/subflows/index.ts -->

Register a child machine under `actors:` on the parent's `setupAgent(...)`, then invoke it by name. The parent treats the child like any other invoked actor, with typed `input` and final output in `onDone`.

[examples/subflows/index.ts](../examples/subflows/index.ts) delegates a topic to a research child.

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

The child is its own `setupAgent(...)` agent, taking `{ topic }` and returning `{ research }`. Its `researchTopic` request inherits the parent run's executors automatically, with no per-child binding. See [Executor inheritance](#executor-inheritance).

### Observing child actors

<!-- onTransition vs inspect/inspectTransitions from src/run-agent.ts -->

`runAgent` offers two ways to observe:

- `onTransition` fires for the root machine's transitions only. Use it for parent progress.
- `inspect` is the raw, system-wide stream covering the root, every invoked child, and spawned actors. It is the only way to see a child's states. Attribute each event with `event.actorRef.id`, which is the invoke id, or with `event.actorRef.src`.

The `inspectTransitions(handler)` helper wraps `inspect`. It filters to `@xstate.transition` events and passes the handler a typed snapshot and actorRef, so you do not write the type check and casts yourself.

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

[examples/subflows/index.ts](../examples/subflows/index.ts) uses both channels side by side.

## Sub-agents as host-owned tools

<!-- host-owned sub-agent tools from examples/ai-sdk-sub-agents/index.ts -->

A sub-agent does not have to be a machine. In this pattern the machine sees a single text request with tools, and the host implements those tools by delegating to worker agents built with another framework.

[examples/ai-sdk-sub-agents/index.ts](../examples/ai-sdk-sub-agents/index.ts) exposes `askResearcher` and `askWriter` tools whose `execute` calls a Vercel AI SDK `ToolLoopAgent` worker.

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

Delegation lives entirely on the host side of the boundary, so the machine stays portable.

The host can also provide any async actor, not only tools. The machine declares a named actor source and the host supplies its implementation. That actor can be a remote agent call, a queue round trip, or another framework's runtime. See [Hosts and executors](hosts.md).

## Sibling coordination through events

<!-- event-based sibling coordination from examples/debate-sub-agents/index.ts -->

A parent can invoke several child agents at once and pass messages between them. Each child's `on:` handlers act as its inbox. [examples/debate-sub-agents/index.ts](../examples/debate-sub-agents/index.ts) runs a debate this way.

Turn order is a plain function of the transcript length, so the parent holds no extra state.

```ts no-check
// Whose turn it is at transcript position `index`: A, B, A, B, …
function turnAt(index: number) {
  return {
    stance: index % 2 === 0 ? 'affirmative' : 'negative',
    round: Math.floor(index / 2) + 1,
  } as const;
}

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
  awaiting: {
    on: {
      'DEBATE.ARGUMENT_SUBMITTED': ({ context, event }) => {
        const transcript = [
          ...context.transcript,
          { stance: event.stance, round: event.round, text: event.text },
        ];
        // Two turns per round.
        return transcript.length >= context.rounds * 2
          ? { target: 'concluding', context: { transcript } }
          : { target: 'requesting', context: { transcript } };
      },
    },
  },
  // ...
},
```

Each debater idles until it receives `DEBATE.ARGUMENT_REQUESTED`, composes an argument, and sends `DEBATE.ARGUMENT_SUBMITTED` back. The parent appends the argument to the shared transcript and requests the next turn. Machines share state only through the messages they send.

<!-- viz: debate parent machine: requesting -> awaiting loop, with DEBATE.ARGUMENT_REQUESTED sent to the current stance child and DEBATE.ARGUMENT_SUBMITTED returning -->

## Fan-out

This alpha ships no dedicated fan-out primitive. Use XState dynamic spawn when each branch should be a visible child actor with independent progress and persisted identity. That is the `enq.spawn(actors.worker, ...)` shape shown in [Dynamic binding](#dynamic-binding).

Use `Promise.all(...)` inside a host actor or tool when the branches are an implementation detail and the machine only needs their combined result. See [fan-out](../examples/fan-out/index.ts) for visible dynamic branches, and [deep research](../examples/deep-research/index.ts) for a larger planner-worker-reducer flow.

## Related

- [Agent patterns](patterns.md#multi-agent): the full list of sub-agent and multi-machine examples.
- [Use in any stack](any-stack.md#controlled-and-uncontrolled): controlled and uncontrolled hosts.
- [Hosts and executors](hosts.md): the executor contract children inherit.
- [Preset machines](machines-presets.md): `createSupervisorMachine` and `createHandoffMachine`.
