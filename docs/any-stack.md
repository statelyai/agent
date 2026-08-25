---
title: Use in any stack
description: One agent machine runs unchanged in a local script, an HTTP route, or an edge runtime. Only the executors are host-specific.
---

> **Alpha:** `@statelyai/agent` 2.0 is in alpha. APIs can change between releases; pin an exact version. Feedback: [github.com/statelyai/agent](https://github.com/statelyai/agent/issues).

An agent machine does not name a provider, a server, or a runtime. The same definition runs locally, behind an HTTP route, or on an edge runtime. The only host-specific part is the [executors](hosts.md), the functions that call a model.

This page defines one machine, runs it in both controlled and uncontrolled mode, and then runs it in two production stacks. Each walkthrough is labeled with the stack and the mode it uses: Express with `runAgent` (controlled), and a Cloudflare Durable Object with `provideExecutors` (uncontrolled). Stack and mode are independent choices. Express can run uncontrolled, and a Durable Object can call `runAgent`.

## Machine definition

This machine drafts an announcement, settles idle for human review, and publishes on approval. None of it is host-aware.

<!-- viz: announce machine: drafting (invoke writeDraft) -> reviewing -> APPROVE -> published (final); REJECT returns to drafting with the revision reason appended -->


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

Every host binds executors in one of two ways:

- Controlled, with `runAgent`. The library owns the loop. It drives the machine to a settle point of `done`, `idle`, or `error`, handles idle pauses, and descends into child machines. Use it when the host wants a request/response boundary and snapshot persistence.
- Uncontrolled, with `provideExecutors` and `createActor`. You bind executors onto the machine and run it as a plain XState actor. There is no run loop and no idle settling. The actor runs itself and you observe it. Use it when the host already owns an actor lifecycle, such as a React component or a Durable Object.

The machine and the executors are the same in both modes.

```ts
import { createAiSdkExecutors, defineModels } from "@statelyai/agent/ai-sdk";
import { openai } from "@ai-sdk/openai";

// Model IDs here are illustrative; substitute your provider's current models.
const models = defineModels({ writer: openai("gpt-5.4-mini") });
const executors = createAiSdkExecutors({ models });
```

## Controlled host

Run the machine with `runAgent` and handle the idle pause inline.

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

Run the same machine as a plain XState actor.

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

[examples/react-uncontrolled](../examples/react-uncontrolled/index.tsx) runs this same actor inside a React component, where the UI observes snapshots, sends user events, and renders streamed chunks from `onChunk`.

For external control with no live actor, use XState's pure `transition(…)` and `initialTransition(…)` functions, which step the machine one event at a time. This is the lowest-level uncontrolled form, and durable hosts build on it. See [The step path](steps.md).

## Host walkthroughs

These hosts run the same machine without changing it.

### Express (controlled)

This host calls `runAgent` once per request. The process holds no live actor between requests, so any worker can handle the resume. An idle settle plus a persisted snapshot is how human-in-the-loop works over HTTP.

The `snapshots` map below is module-level and therefore per-process. Replace it with shared storage such as Redis or a database before any worker can serve a resume. The route reports the human's options with [`getAcceptedEvents`](human-in-the-loop.md#the-humans-choices).

<!-- viz: sequence diagram: client POST /agent -> runAgent -> model -> idle settle -> 202 with snapshot id; client POST /agent/:id/resume with APPROVE -> runAgent from snapshot -> done output -->


```ts no-check
import express from "express";
import { getAcceptedEvents, runAgent } from "@statelyai/agent";
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
    snapshots.set(id, result.persistedSnapshot ?? result.snapshot);
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

For the full reference, including revision loops and typed state meta, see [examples/express-host](../examples/express-host/index.ts). The same structure applies to [Hono](../examples/hono-host/index.ts), [Next.js](../examples/next-host), and [TanStack Start](../examples/tanstack-start-host).

### Cloudflare Durable Object (uncontrolled)

A Durable Object owns a long-lived actor and its own persistence, so bind executors with `provideExecutors` and run a plain `createActor`. The persisted snapshot lives in Durable Object state, so a run survives hibernation and resumes where it stopped. On restore the snapshot wins: `createActor(machine, { snapshot, input })` ignores `input` entirely whenever a snapshot is present, so the `input` below applies only to a first start. Model resolution comes from the environment binding, so the class does not name a provider.

```ts no-check
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

The [cloudflare-agent-host](../examples/cloudflare-agent-host/index.ts) example is a Durable Object class you can use directly, with the `wrangler.toml` and subclass wiring included. For Workers that handle one turn per request, [cloudflare-workers-ai-host](../examples/cloudflare-workers-ai-host/index.ts) drives the [step path](steps.md) against a raw Workers AI binding.

### More host examples

Each of these is a runnable file rather than a walkthrough, and none of them changes the machine.

- Agent frameworks calling the machine as a tool: [Mastra](../examples/mastra-host/index.ts), [LangChain](../examples/langchain-host/index.ts), [Flue 2](../examples/flue-host/index.ts), and [Eve](../examples/eve-host/agent.ts). The framework converses, and the machine owns legality and the human pause. Flue 2 also runs the other way around in [flue-owned.ts](../examples/flue-host/flue-owned.ts), where Flue's hooks own each step and a small machine replaces the step variable.
- Streaming a run to a browser client: [the AI SDK UI message stream](../examples/ai-sdk-ui-stream/index.ts) behind a `useChat` route, [TanStack AI's AG-UI protocol over SSE](../examples/tanstack-ai-stream/index.ts), and [plain SSE](../examples/sse-transport/index.ts).

## What changes per host

You import the machine and do not edit it. Three things change per host:

- How executors are built. Use the AI SDK locally and injected model resolution on the edge.
- Whether the host is controlled with `runAgent` or uncontrolled with `provideExecutors` and `createActor`.
- Where the snapshot is persisted. Options include an in-memory map, Durable Object state, or nowhere for a local run that never pauses.

## Related

- [Hosts and executors](hosts.md): the executor contract, the shipped adapters, and writing your own.
- [Agent patterns](patterns.md): copy-paste machines for ReAct, RAG, supervisor, and more; each runs in any host this same way.
- [Human in the loop](human-in-the-loop.md): the idle-first pause and snapshot resume, in depth.
- [The step path](steps.md): the lower-level per-model-call loop for durable hosts.
