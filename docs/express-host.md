---
title: Express host
description: Serve an agent machine from an Express route, with idle settling and snapshot persistence as human-in-the-loop over HTTP.
---

> **Alpha:** `@statelyai/agent` 2.0 is in alpha. APIs can change between releases; pin an exact version. Feedback: [github.com/statelyai/agent](https://github.com/statelyai/agent/issues).

A controlled host: `runAgent` per request. An idle settle plus a persisted snapshot **is** human-in-the-loop over HTTP: the process holds no live actor between requests, so any worker can pick up the resume. The machine ([authored here](any-stack.md#the-machine-authored-once)) is imported and untouched; only the executors and the persistence are host code.

```ts
import express from "express";
import {
  getAcceptedEvents,
  persistSnapshot,
  runAgent,
} from "@statelyai/agent";
import { createAiSdkExecutors, defineModels } from "@statelyai/agent/ai-sdk";
import { openai } from "@ai-sdk/openai";
import type { Snapshot } from "xstate";
import { announceMachine } from "./announce-machine.js";

const models = defineModels({ writer: openai("gpt-5.4-mini") });
const executors = createAiSdkExecutors({ models });

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
    return res.status(202).json({
      id,
      draft: result.snapshot.context.draft,
      acceptedEvents: getAcceptedEvents(result.snapshot).map((e) => e.type),
    });
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

The full reference, including revision loops and typed state meta, is [examples/express-host](../examples/express-host/index.ts). The same shape ports directly to [Hono](../examples/hono-host/index.ts), [Next.js](../examples/next-host), and [TanStack Start](../examples/tanstack-start-host).

## Related

- [Use in any stack](any-stack.md): the machine this host serves, and the controlled/uncontrolled distinction.
- [Human in the loop](human-in-the-loop.md): the idle-first pause and snapshot resume in depth.
- [Hosts and executors](hosts.md): building the executors.
