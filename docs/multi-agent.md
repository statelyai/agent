---
title: Multi-agent composition
description: Compose agent machines today by invoking them as child actors, exposing sub-agents as host-owned tools, and coordinating siblings through events.
---

## Multi-agent composition

Because an agent machine is an XState actor, you compose agents with the actor patterns XState already gives you. There is no separate orchestration layer to learn:

- invoke one machine from another as a **child actor**
- expose sub-agents as **host-owned tools**
- let sibling machines coordinate by **sending events**

The framing stays the same: the machine decides, the [host](hosts.md) executes. Composition changes which machine is deciding, not who talks to the model.

## Agent machines as child actors

<!-- child-actor composition from examples/subflows/index.ts -->

Register a child machine under `actorSources:` on the parent's `setupAgent(...)`, then invoke it by name. The parent treats the child like any other invoked actor: typed `input`, final output in `onDone`.

[examples/subflows/index.ts](../examples/subflows/index.ts) builds a research-then-write pipeline this way:

```ts
const agentSetup = setupAgent({
  models,
  context: z.object({
    topic: z.string(),
    notes: z.string().nullable(),
    final: z.string().nullable(),
  }),
  input: z.object({ topic: z.string() }),
  output: finalOutputSchema,
  actorSources: {
    researchAgent: research.machine.provide({
      actorSources: {
        /* ... */
      },
    }),
    writerAgent: writer.machine.provide({
      actorSources: {
        /* ... */
      },
    }),
  },
});

const machine = agentSetup.createMachine({
  initial: "researching",
  states: {
    researching: {
      invoke: {
        src: "researchAgent",
        input: ({ context }) => ({ topic: context.topic }),
        onDone: ({ output }) => ({ target: "writing", context: { notes: output.notes } }),
      },
    },
    writing: {
      invoke: {
        src: "writerAgent",
        input: ({ context }) => ({ notes: context.notes ?? "" }),
        onDone: ({ output }) => ({ target: "done", context: { final: output.draft } }),
      },
    },
    done: { type: "final", output: ({ context }) => ({ final: context.final ?? "" }) },
  },
});
```

A child machine's own requests inherit the executors you pass to `runAgent`, no per-child binding needed. The section on nested executor inheritance below explains the rules.

### Observing child actors

<!-- onTransition vs inspect/inspectTransitions from src/run-agent.ts -->

`runAgent` exposes two observation seams:

- **`onTransition`** fires for the **root** machine's transitions only. Use it for parent progress.
- **`inspect`** is the raw, system-wide inspection stream (the root machine, every invoked child machine, and spawned actors), so it is the only way to see a child's states. Attribute each event via `event.actorRef.id` (the invoke id) or `.src`.

`inspectTransitions(handler)` wraps `inspect`: it filters the stream to `@xstate.transition` events and hands the handler the typed snapshot and actorRef, replacing the manual `event.type === '@xstate.transition'` check and casts.

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

A sub-agent does not have to be a machine. In this pattern the machine sees a single text request with tools; the host decides those tools delegate to worker agents built with another framework.

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
      askWriter: {
        description: 'Ask the writer sub-agent for final wording.',
        inputSchema: z.object({ prompt: z.string() }),
        execute: createSubAgentExecute(subAgents, 'writer'),
      },
    },
  },
},
```

The machine stays portable because the delegation lives entirely on the host side of the boundary.

The same idea generalizes past tools: the host can provide **any async actor**. The machine declares a named actor source; the host supplies its implementation with `machine.provide({ actorSources })` or `logic.withExecutor(...)`. That actor can be a remote agent call, a queue round trip, or another framework's runtime. See [Hosts and executors](hosts.md).

## Sibling coordination through events

<!-- event-based sibling coordination from examples/debate-sub-agents/index.ts -->

A parent machine can invoke several child agents at once and pass messages between them, using each child's `on:` handlers as its inbox. [examples/debate-sub-agents/index.ts](../examples/debate-sub-agents/index.ts) runs a debate this way:

```ts
invoke: [
  { id: 'affirmativeDebater', src: 'debater', input: ({ context }) => ({ stance: 'affirmative', question: context.question }) },
  { id: 'negativeDebater', src: 'debater', input: ({ context }) => ({ stance: 'negative', question: context.question }) },
],
states: {
  requestingArgument: {
    always: ({ context, children }, enq) => {
      const turn = nextTurn(context.transcript.length);
      enq.sendTo(children[turn.actorId], {
        type: 'DEBATE.ARGUMENT_REQUESTED',
        round: turn.round,
        question: context.question,
        transcript: context.transcript,
      });
      return { target: 'waitingForArgument' };
    },
  },
  // ...
},
```

Each debater sits idle until it receives `DEBATE.ARGUMENT_REQUESTED`, composes an argument, and sends `DEBATE.ARGUMENT_SUBMITTED` back. The parent appends to a shared transcript and requests the next turn. The machines share state only through the messages they choose to send.

## Nested-machine executor inheritance

<!-- nested executor inheritance from src/run-agent.ts and examples/subflows -->

`runAgent` rebinds the executors you pass it (`generateText`/`streamText`/`decide`) onto every unbound agent request in the machine, **including requests inside invoked child machines, at any depth**. A child request inherits the same host-backed executors as the parent's own requests and shares the run's `maxModelCalls` budget, `onTrace`, `onChunk`, and `onResult`.

```ts
const result = await runAgent(parentMachine, {
  input: { topic: "agents" },
  executors: { generateText }, // covers the parent's requests AND the child's researchTopic
});
```

The rules:

- **Inheritance is the default.** Any request reached through string-keyed actor sources (invoke `src` strings, registered `actorSources`) inherits, no matter how deeply nested. Cycles are handled.
- **Explicit bindings win.** A request that already carries its own executor (via `.withExecutor(...)`, `bindRequestExecutor(...)`, or a child's own `.provide({ actorSources })`) keeps it. Explicit binding shadows inheritance, so the parent's executors are never called for it.
- **Missing executors still fail fast.** If a reachable request needs an executor kind you didn't pass (e.g. a child has a `mode: 'stream'` request but `runAgent` got no `streamText`), binding throws a loud error naming the invoke chain and the request `src` before any actor runs.
- **Escape hatch for dynamic spawns.** Logics created dynamically (e.g. machine factories used with `enq.spawn`) aren't in any invoke config for the static bind walk to reach, so they can't inherit. Bind those explicitly with `bindRequestExecutor(...)` / `.withExecutor(...)` (see [examples/fan-out/index.ts](../examples/fan-out/index.ts)). The same applies to a child invoked as a **direct-object** `src` (an inline machine object rather than a registered name): register it as a string-keyed source to let it inherit, or bind its requests yourself.

[examples/subflows/index.ts](../examples/subflows/index.ts) shows the default: the parent registers the child under `actorSources.child`, passes `generateText` to `runAgent`, and the child's `researchTopic` request inherits it, no nested `.provide`.

## Fan-out today

There is no dedicated fan-out primitive in this alpha. To run many sub-agents in parallel, use plain `Promise.all(...)` over host actors, inside an executor or a tool's `execute`, and return the combined result to the machine as a single output. A Send-style dynamic-parallelism helper is not shipped yet.

See [Examples](examples.md) for the full list of sub-agent and multi-machine examples.
