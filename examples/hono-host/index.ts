/**
 * Hono host — the same controlled-mode HTTP shape as `../express-host`, written
 * idiomatically for Hono, plus one streaming endpoint.
 *
 * Controlled seam (identical semantics to express-host):
 *   - POST /agent { topic }            -> runAgent settles idle (draft ready);
 *                                         snapshot persisted in-memory by run id.
 *   - POST /agent/:id/resume { event } -> resume that snapshot with APPROVE/REJECT.
 *
 * Streaming seam:
 *   - POST /agent/stream { topic }     -> a `mode: 'stream'` request; runAgent's
 *                                         `onChunk` is piped into the HTTP
 *                                         response body as it arrives.
 *
 * Executors are injected (default: a keyless mock — no network at import).
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/hono-host/index.ts
 */
import { Hono } from "hono";
import { z } from "zod";
import {
  getAcceptedEvents,
  getStateMeta,
  persistSnapshot,
  runAgent,
  setupAgent,
  type AgentRequestExecutors,
} from "@statelyai/agent";
import type { Snapshot } from "xstate";

// ─── Controlled machine: draft → idle review → publish ───

const contextSchema = z.object({ topic: z.string(), draft: z.string().nullable() });

const reviewSetup = setupAgent({
  context: contextSchema,
  input: z.object({ topic: z.string() }),
  output: z.object({ published: z.boolean(), draft: z.string() }),
  meta: z.object({ interaction: z.object({ label: z.string() }).optional() }),
  events: { APPROVE: z.object({}), REJECT: z.object({ reason: z.string() }) },
  isSuspended: (snapshot) => snapshot.hasTag("awaiting-review"),
  requests: {
    writeDraft: {
      schemas: { input: z.object({ topic: z.string() }), output: z.string() },
      model: "writer",
      prompt: ({ input }) => `Write a short announcement about: ${input.topic}`,
    },
  },
  states: {
    reviewing: { context: { draft: z.string() } },
    published: { context: { draft: z.string() } },
  },
});

export const announceMachine = reviewSetup.createMachine({
  id: "hono-announce",
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
    reviewing: {
      tags: ["awaiting-review"],
      meta: { interaction: { label: "Approve to publish, or reject with a reason." } },
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
      output: ({ context }) => ({ published: true, draft: context.draft }),
    },
  },
});

// ─── Streaming machine: one `mode: 'stream'` request, then done ───

const streamSetup = setupAgent({
  context: z.object({ topic: z.string(), text: z.string().nullable() }),
  input: z.object({ topic: z.string() }),
  output: z.object({ text: z.string() }),
  requests: {
    streamDraft: {
      mode: "stream",
      schemas: { input: z.object({ topic: z.string() }), output: z.string() },
      model: "writer",
      prompt: ({ input }) => `Write an announcement about: ${input.topic}`,
    },
  },
  states: { done: { context: { text: z.string() } } },
});

export const streamMachine = streamSetup.createMachine({
  id: "hono-stream",
  context: ({ input }) => ({ topic: input.topic, text: null }),
  initial: "streaming",
  states: {
    streaming: {
      invoke: {
        src: "streamDraft",
        input: ({ context }) => ({ topic: context.topic }),
        onDone: ({ output }) => ({ target: "done", context: { text: output } }),
      },
    },
    done: { type: "final", output: ({ context }) => ({ text: context.text }) },
  },
});

// ─── Host ───

const snapshots = new Map<string, Snapshot<unknown>>();

/** Keyless mock: generate returns a draft; stream yields a few chunks. */
const mockExecutors: Partial<AgentRequestExecutors> = {
  generateText: async () => ({ output: "Big news: the deploy pipeline just got faster." }),
  streamText: async (_request, info) => {
    const chunks = ["Big news: ", "the deploy pipeline ", "just got faster."];
    for (const chunk of chunks) info?.onChunk?.(chunk);
    return { output: chunks.join("") };
  },
};

export function createApp(executors: Partial<AgentRequestExecutors> = mockExecutors): Hono {
  const app = new Hono();

  app.post("/agent", async (c) => {
    const { topic = "the new deploy pipeline" } = await c.req.json().catch(() => ({}));
    const result = await runAgent(announceMachine, { input: { topic }, executors });

    if (result.status === "idle") {
      const id = crypto.randomUUID();
      snapshots.set(id, persistSnapshot(result.snapshot));
      const { interaction } = getStateMeta(result.snapshot);
      return c.json(
        {
          id,
          status: "idle",
          draft: result.snapshot.context.draft,
          prompt: interaction?.label,
          acceptedEvents: getAcceptedEvents(result.snapshot).map((e) => e.type),
        },
        202,
      );
    }
    if (result.status === "done") return c.json({ status: "done", output: result.output });
    return c.json({ status: result.status }, 500);
  });

  app.post("/agent/:id/resume", async (c) => {
    const id = c.req.param("id");
    const snapshot = snapshots.get(id);
    if (!snapshot) return c.json({ error: "unknown run id" }, 404);

    const event = (await c.req.json().catch(() => ({})))?.event;
    const result = await runAgent(announceMachine, { snapshot, event, executors });
    if (result.status === "done") {
      snapshots.delete(id);
      return c.json({ status: "done", output: result.output });
    }
    if (result.status === "idle") {
      snapshots.set(id, persistSnapshot(result.snapshot));
      return c.json({ status: "idle", draft: result.snapshot.context.draft }, 202);
    }
    return c.json({ status: result.status }, 500);
  });

  // Streaming: runAgent's onChunk is enqueued into the response body as it arrives.
  app.post("/agent/stream", async (c) => {
    const { topic = "the new deploy pipeline" } = await c.req.json().catch(() => ({}));
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        const encoder = new TextEncoder();
        await runAgent(streamMachine, {
          input: { topic },
          executors,
          onChunk: (chunk) => controller.enqueue(encoder.encode(chunk)),
        });
        controller.close();
      },
    });
    return c.body(body, 200, { "content-type": "text/plain; charset=utf-8" });
  });

  return app;
}

// Direct run via @hono/node-server if installed; otherwise this file just
// typechecks. Try it with:
//   curl -sX POST localhost:3000/agent -d '{"topic":"CI speedups"}'
//   curl -N -X POST localhost:3000/agent/stream -d '{"topic":"CI speedups"}'
if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  const port = Number(process.env.PORT ?? 3000);
  const app = createApp();
  // `serve` lives in @hono/node-server (not a dependency here). Wire it up in a
  // real project; the fetch handler below is what any runtime calls.
  console.log(`hono-host app ready. Serve app.fetch with your runtime on :${port}.`);
  void app;
}
