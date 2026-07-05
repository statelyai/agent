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

<!-- child-actor composition from examples/xstate-sub-agents/index.ts -->

Register a child machine under `actorSources:` on the parent's `setupAgent(...)`, then invoke it by name. The parent treats the child like any other invoked actor: typed `input`, final output in `onDone`.

[examples/xstate-sub-agents/index.ts](../examples/xstate-sub-agents/index.ts) builds a research-then-write pipeline this way:

```ts
const agentSetup = setupAgent({
  models,
  context: z.object({ topic: z.string(), notes: z.string().nullable(), final: z.string().nullable() }),
  input: z.object({ topic: z.string() }),
  output: finalOutputSchema,
  actorSources: {
    researchAgent: research.machine.provide({ actorSources: { /* ... */ } }),
    writerAgent: writer.machine.provide({ actorSources: { /* ... */ } }),
  },
});

const machine = agentSetup.createMachine({
  initial: 'researching',
  states: {
    researching: {
      invoke: {
        src: 'researchAgent',
        input: ({ context }) => ({ topic: context.topic }),
        onDone: ({ output }) => ({ target: 'writing', context: { notes: output.notes } }),
      },
    },
    writing: {
      invoke: {
        src: 'writerAgent',
        input: ({ context }) => ({ notes: context.notes ?? '' }),
        onDone: ({ output }) => ({ target: 'done', context: { final: output.draft } }),
      },
    },
    done: { type: 'final', output: ({ context }) => ({ final: context.final ?? '' }) },
  },
});
```

Each child binds its own request executors with `.provide({ actorSources })` **before** being registered as a parent actor. The section on nested executor binding below explains why.

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

## Nested-machine executor binding

<!-- nested executor binding caveat from src/run-agent.ts and examples/langgraph-subflows -->

> **Warning:** `runAgent` binds executors only for the **top-level** machine's own text and decision sources. A child machine keeps its own `.provide({ actorSources })` binding; `runAgent` does not reach into it; child requests do **not** inherit the parent's `generateText`/`streamText`/`decide`. Bind the child's request executors yourself before registering it.
>
> `runAgent` validates this at **bind time**: it recurses into invoked child machines (arbitrarily deep) and throws a loud error naming the child and the unbound request `src` before any actor runs, rather than settling the parent in a wrong idle-looking state.

[examples/langgraph-subflows/index.ts](../examples/langgraph-subflows/index.ts) shows the pattern:

```ts
const result = await runAgent(parentMachine, {
  input: { topic: 'agents' },
  generateText: async () => ({}),
  actorSources: {
    child: childMachine.provide({
      actorSources: {
        researchTopic: childSetup.requests.researchTopic.withExecutor(
          async ({ input }) => `Research: ${input.topic}`,
        ),
      },
    }),
  },
});
```

The `generateText` passed to `runAgent` covers the parent's own requests; the child's request is covered by its own `.withExecutor(...)` binding.

## Fan-out today

There is no dedicated fan-out primitive in this alpha. To run many sub-agents in parallel, use plain `Promise.all(...)` over host actors, inside an executor or a tool's `execute`, and return the combined result to the machine as a single output. A Send-style dynamic-parallelism helper is not shipped yet.

See [Examples](examples.md) for the full list of sub-agent and multi-machine examples.
