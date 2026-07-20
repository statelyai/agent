---
title: Multi-agent composition
description: Compose agent machines today by invoking them as child actors, exposing sub-agents as host-owned tools, and coordinating siblings through events.
---

> **Alpha:** `@statelyai/agent` 2.0 is in alpha. APIs can change between releases; pin an exact version. Feedback: [github.com/statelyai/agent](https://github.com/statelyai/agent/issues).

## Multi-agent composition

An agent machine is an XState actor, so you compose agents with XState's existing actor patterns. No separate orchestration layer:

- invoke one machine from another as a **child actor**
- expose sub-agents as **host-owned tools**
- let sibling machines coordinate by **sending events**

The machine decides, the [host](hosts.md) executes. Composition changes which machine is deciding, not who talks to the model.

## Agent machines as child actors

<!-- child-actor composition from examples/subflows/index.ts -->

Register a child machine under `actorSources:` on the parent's `setupAgent(...)`, then invoke it by name. The parent treats the child like any other invoked actor: typed `input`, final output in `onDone`.

[examples/subflows/index.ts](../examples/subflows/index.ts) delegates a topic to a research child this way:

```ts
const parentAgentSetup = setupAgent({
  context: z.object({ topic: z.string(), research: z.string().nullable() }),
  input: z.object({ topic: z.string() }),
  output: z.object({ research: z.string() }),
  actorSources: { child: childMachine },
});

const subflowsMachine = parentAgentSetup.createMachine({
  initial: "delegating",
  states: {
    delegating: {
      invoke: {
        id: "child",
        src: "child",
        input: ({ context }) => ({ topic: context.topic }),
        onDone: ({ output }) => ({ target: "done", context: { research: output.research } }),
      },
    },
    done: { type: "final", output: ({ context }) => ({ research: context.research ?? "" }) },
  },
});
```

`childMachine` is its own `setupAgent(...)` agent (`{ topic } -> { research }`); its `researchTopic` request inherits the parent run's executors automatically.

A child machine's own requests inherit the executors you pass to `runAgent`, no per-child binding needed (see [nested executor inheritance](#nested-machine-executor-inheritance) below).

### Observing child actors

<!-- onTransition vs inspect/inspectTransitions from src/run-agent.ts -->

`runAgent` exposes two observation seams:

- **`onTransition`** fires for the **root** machine's transitions only. Use it for parent progress.
- **`inspect`** is the raw, system-wide stream (root, every invoked child, and spawned actors), so it is the only way to see a child's states. Attribute each event via `event.actorRef.id` (the invoke id) or `.src`.

`inspectTransitions(handler)` wraps `inspect`: it filters to `@xstate.transition` events and hands the handler the typed snapshot and actorRef, replacing the manual `event.type === '@xstate.transition'` check and casts.

```ts
import { inspectTransitions, runAgent } from "@statelyai/agent";

await runAgent(parentMachine, {
  executors: { generateText },
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

```ts
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

This generalizes past tools: the host can provide **any async actor**. The machine declares a named actor source; the host supplies its implementation with `machine.provide({ actorSources })` or `logic.withExecutor(...)`. That actor can be a remote agent call, a queue round trip, or another framework's runtime. See [Hosts and executors](hosts.md).

## Sibling coordination through events

<!-- event-based sibling coordination from examples/debate-sub-agents/index.ts -->

A parent can invoke several child agents at once and pass messages between them, using each child's `on:` handlers as its inbox. [examples/debate-sub-agents/index.ts](../examples/debate-sub-agents/index.ts) runs a debate this way:

```ts
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

## Nested-machine executor inheritance

<!-- nested executor inheritance from src/run-agent.ts and examples/subflows -->

`runAgent` rebinds the executors you pass (`generateText`/`streamText`/`decide`) onto every unbound agent request, **including requests inside invoked child machines, at any depth**. A child request inherits the same host-backed executors as the parent and shares the run's `maxModelCalls` budget, `onTrace`, `onChunk`, and `onResult`. Passing `executors: { generateText }` to `runAgent(parentMachine, ...)` covers both the parent's requests and the child's.

The rules:

- **Inheritance is the default.** Any request reached through string-keyed actor sources (invoke `src` strings, registered `actorSources`) inherits, however deeply nested. Cycles are handled.
- **Explicit bindings win.** A request already carrying its own executor (via `.withExecutor(...)`, `bindRequestExecutor(...)`, or a child's own `.provide({ actorSources })`) keeps it; the parent's executors are never called for it.
- **Missing executors fail fast.** If a reachable request needs an executor kind you didn't pass (e.g. a child's `mode: 'stream'` request but no `streamText`), binding throws before any actor runs, naming the invoke chain and request `src`.
- **Escape hatch for dynamic spawns.** Logics created dynamically (e.g. machine factories used with `enq.spawn`) aren't in any invoke config for the static bind walk to reach, so they can't inherit. Bind them explicitly with `bindRequestExecutor(...)` / `.withExecutor(...)` (see [examples/fan-out/index.ts](../examples/fan-out/index.ts)). Same for a child invoked as a **direct-object** `src` (an inline machine object, not a registered name): register it as a string-keyed source, or bind its requests yourself.

## Fan-out today

No dedicated fan-out primitive in this alpha. To run many sub-agents in parallel, use `Promise.all(...)` over host actors inside an executor or a tool's `execute`, and return the combined result to the machine as a single output. A Send-style dynamic-parallelism helper is not shipped yet.

See [Examples](examples.md) for the full list of sub-agent and multi-machine examples.
