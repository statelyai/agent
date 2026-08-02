---
title: Use in any stack
description: One agent machine runs unchanged in a local script, an HTTP route, or an edge runtime. Only the executors are host-specific.
---

> **Alpha:** `@statelyai/agent` 2.0 is in alpha. APIs can change between releases; pin an exact version. Feedback: [github.com/statelyai/agent](https://github.com/statelyai/agent/issues).

An agent machine is a portable blueprint: **the machine decides, the host executes.** The machine never names a provider, a server, or a runtime, so the same definition runs unchanged locally, behind an HTTP route, or on the edge. The only host-specific part is the [executors](hosts.md), the functions that call a model.

This page authors one machine, runs it both ways a host can, then drops it into two real stacks.

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

## Host walkthroughs

The same machine, dropped into real stacks with zero machine changes.

### Express (controlled)

`runAgent` per request. The process holds no live actor between requests, so any worker can pick up the resume: an idle settle plus a persisted snapshot **is** human-in-the-loop over HTTP.

```ts
import express from "express";
import { getAcceptedEvents, persistSnapshot, runAgent } from "@statelyai/agent";
import type { Snapshot } from "xstate";
import { announceMachine } from "./announce-machine.js";
import { executors } from "./executors.js"; // as built above

const snapshots = new Map<string, Snapshot<unknown>>();
const app = express();
app.use(express.json());

// Start a run. Settles idle (draft ready) or done.
app.post("/agent", async (req, res) => {
  const result = await runAgent(announceMachine, {
    input: { topic: String(req.body?.topic ?? "the new deploy pipeline") },
    executors,
  });
  if (result.status === "idle") {
    const id = crypto.randomUUID();
    snapshots.set(id, persistSnapshot(result.snapshot));
    const { draft } = result.snapshot.context;
    const accepted = getAcceptedEvents(result.snapshot).map((e) => e.type);
    return res.status(202).json({ id, draft, acceptedEvents: accepted });
  }
  if (result.status === "done") return res.json({ output: result.output });
  return res.status(500).json({ status: result.status });
});

// Resume a persisted run with a human event.
app.post("/agent/:id/resume", async (req, res) => {
  const snapshot = snapshots.get(String(req.params.id));
  if (!snapshot) return res.status(404).json({ error: "unknown run id" });
  const result = await runAgent(announceMachine, {
    snapshot,
    event: req.body?.event,
    executors,
  });
  if (result.status === "done") return res.json({ output: result.output });
  return res.status(202).json({ draft: result.snapshot.context.draft });
});

app.listen(3000);
```

The full reference, with revision loops and typed state meta, is [examples/express-host](../examples/express-host/index.ts). The same shape ports directly to [Hono](../examples/hono-host/index.ts), [Next.js](../examples/next-host), and [TanStack Start](../examples/tanstack-start-host).

### Cloudflare Durable Object (uncontrolled)

A Durable Object already owns a long-lived actor and its own persistence, so bind executors with `provideExecutors` and run a plain `createActor`. The persisted snapshot lives in Durable Object state, so a run survives hibernation and resumes where it left off. Model resolution is injected from the environment binding, so the class stays provider-agnostic.

```ts
import { Agent, type Connection } from "agents";
import { createActor, type Actor, type Snapshot } from "xstate";
import { parseAgentEvent, provideExecutors } from "@statelyai/agent";
import { createAiSdkExecutors, defineModels } from "@statelyai/agent/ai-sdk";
import { createWorkersAI } from "workers-ai-provider";
import { announceMachine } from "./announce-machine.js";

interface Env {
  AI: Ai;
}
interface State {
  snapshot?: Snapshot<unknown>;
}

export class AnnounceAgent extends Agent<Env, State> {
  initialState: State = {};
  #actor: Actor<typeof announceMachine> | undefined;

  onStart() {
    const workersai = createWorkersAI({ binding: this.env.AI });
    const models = defineModels({ writer: workersai("@cf/meta/llama-3.1-8b-instruct") });
    const machine = provideExecutors(announceMachine, createAiSdkExecutors({ models }));

    // Restore from the persisted snapshot if the DO was evicted mid-run.
    this.#actor = createActor(machine, {
      snapshot: this.state.snapshot,
      input: { topic: "the new deploy pipeline" },
    });
    this.#actor.subscribe((snapshot) => {
      // Durable persistence on every transition.
      this.setState({ snapshot: this.#actor!.getPersistedSnapshot() });
      this.broadcast(JSON.stringify({ type: "state", value: snapshot.value }));
    });
    this.#actor.start();
  }

  onMessage(connection: Connection, message: string) {
    // Client messages are machine events; parseAgentEvent validates them
    // against the snapshot's accepted events before they reach the actor.
    const snapshot = this.#actor?.getSnapshot();
    if (!snapshot) return;
    this.#actor?.send(parseAgentEvent(snapshot, JSON.parse(message)));
  }
}
```

The shipped [cloudflare-agent-host](../examples/cloudflare-agent-host/index.ts) is a drop-in Durable Object class, with the `wrangler.toml` and subclass wiring spelled out. For one-turn-per-request Workers, [cloudflare-workers-ai-host](../examples/cloudflare-workers-ai-host/index.ts) drives the lower-level [step path](steps.md) against a raw Workers AI binding.

## What changes per host

The machine is **imported, never edited**. Only three things change:

- how executors are built (AI SDK locally, injected model resolution on the edge);
- controlled (`runAgent`) or uncontrolled (`provideExecutors` + `createActor`);
- where the snapshot is persisted (in-memory map, Durable Object state, or nothing for a straight-through local run).

## Related

- [Hosts and executors](hosts.md): the executor contract, the shipped adapters, and writing your own.
- [Agent patterns](patterns.md): copy-paste machines for ReAct, RAG, supervisor, and more; each runs in any host this same way.
- [Human in the loop](human-in-the-loop.md): the idle-first pause and snapshot resume, in depth.
- [The step path](steps.md): the lower-level per-model-call loop for durable hosts.
