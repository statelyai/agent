---
title: Use in any stack
description: One agent machine runs unchanged in a local script, an HTTP route, or an edge runtime. Only the executors are host-specific.
---

> **Alpha:** `@statelyai/agent` 2.0 is in alpha. APIs can change between releases; pin an exact version. Feedback: [github.com/statelyai/agent](https://github.com/statelyai/agent/issues).

An agent machine is a portable blueprint: **the machine decides, the host executes.** The machine never names a provider, a server, or a runtime, so the same definition runs unchanged locally, behind an HTTP route, or on the edge. The only host-specific part is the [executors](hosts.md), the functions that call a model.

This page authors one machine and runs it both ways a host can; the [host guides](#host-guides) then drop the same machine into real stacks.

## The machine (authored once)

A draft-and-review announcer: write a draft, settle idle for a human, publish on approval. Nothing here is host-aware.

```ts
import { z } from "zod";
import { setupAgent } from "@statelyai/agent";

const agentSetup = setupAgent({
  context: z.object({ topic: z.string(), draft: z.string().nullable() }),
  input: z.object({ topic: z.string() }),
  output: z.object({ published: z.boolean(), draft: z.string() }),
  events: { APPROVE: z.object({}), REJECT: z.object({ reason: z.string() }) },
  requests: {
    writeDraft: {
      schemas: { input: z.object({ topic: z.string() }), output: z.string() },
      model: "writer",
      system: "You write short internal announcements, two or three sentences.",
      prompt: ({ input }) => `Write a short announcement about: ${input.topic}`,
    },
  },
  states: {
    reviewing: { context: { draft: z.string() } },
    published: { context: { draft: z.string() } },
  },
});

export const announceMachine = agentSetup.createMachine({
  id: "announce",
  context: ({ input }) => ({ topic: input.topic, draft: null }),
  initial: "drafting",
  states: {
    drafting: {
      invoke: {
        src: "writeDraft",
        input: ({ context }) => ({ topic: context.topic }),
        onDone: ({ output }) => ({ target: "reviewing", context: { draft: output } }),
      },
    },
    // No invoke: the machine rests here until a human sends APPROVE / REJECT.
    reviewing: {
      on: {
        APPROVE: { target: "published" },
        REJECT: ({ context, event }) => ({
          target: "drafting",
          context: { topic: `${context.topic}\nRevision requested: ${event.reason}` },
        }),
      },
    },
    published: {
      type: "final",
      output: ({ context }) => ({ published: true, draft: context.draft ?? "" }),
    },
  },
});
```

## Controlled and uncontrolled

Every host binds executors one of two ways. Same machine, same executors either way.

- **Controlled (`runAgent`):** the library owns the loop. It drives the machine to a settle point (`done` | `idle` | `error`), handles idle pauses, and descends into child machines. Best when the host wants a request/response boundary and snapshot persistence.
- **Uncontrolled (`provideExecutors` + `createActor`):** you bind executors onto the machine and run it as a plain XState actor. No run loop, no idle settling; the machine drives itself and you observe it. Best when the host already owns an actor lifecycle (a React component, a Durable Object).

```ts
import { createAiSdkExecutors, defineModels } from "@statelyai/agent/ai-sdk";
import { openai } from "@ai-sdk/openai";

const models = defineModels({ writer: openai("gpt-5.4-mini") });
const executors = createAiSdkExecutors({ models });
```

## Controlled host

Run the machine end to end with `runAgent`, handling the idle pause inline:

```ts
import { runAgent } from "@statelyai/agent";

const result = await runAgent(announceMachine, {
  input: { topic: "the new deploy pipeline" },
  executors,
});

if (result.status === "idle") {
  // Draft is ready; resume with the human's decision.
  const resumed = await runAgent(announceMachine, {
    snapshot: result.snapshot,
    event: { type: "APPROVE" },
    executors,
  });
  if (resumed.status === "done") console.log(resumed.output);
}
```

## Uncontrolled host

Run the same machine as a plain XState actor:

```ts
import { createActor } from "xstate";
import { provideExecutors } from "@statelyai/agent";

const actor = createActor(provideExecutors(announceMachine, executors), {
  input: { topic: "the new deploy pipeline" },
});
actor.subscribe((snapshot) => {
  if (snapshot.value === "reviewing") actor.send({ type: "APPROVE" });
  if (snapshot.status === "done") console.log(snapshot.output);
});
actor.start();
```

## Host guides

The same machine, dropped into real stacks with zero machine changes:

- [Express host](express-host.md): controlled. Idle settle plus a persisted snapshot is human-in-the-loop over HTTP. The same shape ports to [Hono](../examples/hono-host/index.ts), [Next.js](../examples/next-host), and [TanStack Start](../examples/tanstack-start-host).
- [Cloudflare Durable Object host](cloudflare-host.md): uncontrolled. The Durable Object owns the actor; the snapshot survives hibernation.

Across every host, the machine is **imported, never edited**. Only three things change per host:

- how executors are built (AI SDK locally, injected model resolution on the edge);
- controlled (`runAgent`) or uncontrolled (`provideExecutors` + `createActor`);
- where the snapshot is persisted (in-memory map, Durable Object state, or nothing for a straight-through local run).

## Related

- [Hosts and executors](hosts.md): the executor contract, the shipped adapters, and writing your own.
- [Agent patterns](patterns.md): copy-paste machines for ReAct, RAG, supervisor, and more; each runs in any host this same way.
- [Human in the loop](human-in-the-loop.md): the idle-first pause and snapshot resume shown in the Express host.
- [The step path](steps.md): the lower-level per-model-call loop for durable hosts.
