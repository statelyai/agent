---
title: Cloudflare Durable Object host
description: Run an agent machine inside a Durable Object as a plain XState actor, persisting the snapshot across hibernation.
---

> **Alpha:** `@statelyai/agent` 2.0 is in alpha. APIs can change between releases; pin an exact version. Feedback: [github.com/statelyai/agent](https://github.com/statelyai/agent/issues).

An uncontrolled host: a Durable Object already owns a long-lived actor and its own persistence, so bind executors with `provideExecutors` and run a plain `createActor`. The persisted snapshot lives in Durable Object state, so the machine ([authored here](any-stack.md#the-machine-authored-once)) survives hibernation and resumes exactly where it left off. Model resolution is injected so the class stays provider-agnostic.

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

The shipped [cloudflare-agent-host](../examples/cloudflare-agent-host/index.ts) is a drop-in Durable Object class (with the `wrangler.toml` and subclass wiring spelled out). For one-turn-per-request Workers, [cloudflare-workers-ai-host](../examples/cloudflare-workers-ai-host/index.ts) drives the lower-level [step path](steps.md) against a raw Workers AI binding.

## Related

- [Use in any stack](any-stack.md): the machine this host runs, and the controlled/uncontrolled distinction.
- [The step path](steps.md): the per-model-call loop for durable, one-turn-per-request hosts.
- [Hosts and executors](hosts.md): building the executors.
