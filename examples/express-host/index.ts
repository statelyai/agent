/**
 * Express host — a state-machine agent behind an HTTP API, CONTROLLED mode.
 *
 * Teaches the controlled seam: an Express route hands a machine to `runAgent`
 * from core `@statelyai/agent`, which drives it to a settle point and returns.
 *   - POST /agent { topic }          -> runs until the machine settles. A draft
 *                                       state with no invoke settles `idle`; the
 *                                       snapshot is persisted (in-memory, keyed
 *                                       by run id) and the draft returned.
 *   - POST /agent/:id/resume { event } -> loads that snapshot and resumes with a
 *                                       human event (APPROVE / REJECT), running
 *                                       to `done`.
 *
 * `idle` status + a persisted snapshot IS human-in-the-loop over HTTP: the
 * process holds no live actor between requests — the snapshot is the whole
 * state, so any worker can pick up the resume.
 *
 * Executors are injected (default: a keyless mock, so nothing hits the network
 * at import). Swap in `createAiSdkExecutors({ models })` for real generations.
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/express-host/index.ts
 */
import express, { type Express, type Request, type Response } from "express";
import { z } from "zod";
import {
  getAcceptedEvents,
  getStateMeta,
  persistSnapshot,
  runAgent,
  setupAgent,
  type AgentRequestExecutors,
} from "../../src/index.js";
import type { Snapshot } from "xstate";

// ─── The machine: draft → idle review → publish ───

const contextSchema = z.object({ topic: z.string(), draft: z.string().nullable() });

const agentSetup = setupAgent({
  context: contextSchema,
  input: z.object({ topic: z.string() }),
  output: z.object({ published: z.boolean(), draft: z.string() }),
  meta: z.object({ interaction: z.object({ label: z.string() }).optional() }),
  events: { APPROVE: z.object({}), REJECT: z.object({ reason: z.string() }) },
  // The machine's own wait signal — runAgent settles idle deterministically on it.
  isSuspended: (snapshot) => snapshot.hasTag("awaiting-review"),
  requests: {
    writeDraft: {
      schemas: { input: z.object({ topic: z.string() }), output: z.string() },
      model: "writer",
      system: "You write short internal announcements — two or three sentences.",
      prompt: ({ input }) => `Write a short announcement about: ${input.topic}`,
    },
  },
  states: {
    reviewing: { context: { draft: z.string() } },
    published: { context: { draft: z.string() } },
  },
});

export const announceMachine = agentSetup.createMachine({
  id: "express-announce",
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
    // No invoke: runAgent settles idle here and waits for the human's event.
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

// ─── Host: in-memory snapshot store keyed by run id ───

const snapshots = new Map<string, Snapshot<unknown>>();

/** Keyless mock so the example runs (and tests) with no API key or network. */
const mockExecutors: Partial<AgentRequestExecutors> = {
  generateText: async () => ({ output: "Big news: the deploy pipeline just got faster." }),
};

export function createApp(executors: Partial<AgentRequestExecutors> = mockExecutors): Express {
  const app = express();
  app.use(express.json());

  // Start a run. Settles idle (draft ready) or done.
  app.post("/agent", async (req: Request, res: Response) => {
    const topic = String(req.body?.topic ?? "the new deploy pipeline");
    const result = await runAgent(announceMachine, { input: { topic }, executors });

    if (result.status === "idle") {
      const id = crypto.randomUUID();
      snapshots.set(id, persistSnapshot(result.snapshot));
      const { interaction } = getStateMeta(result.snapshot);
      return res.status(202).json({
        id,
        status: "idle",
        draft: result.snapshot.context.draft,
        prompt: interaction?.label,
        acceptedEvents: getAcceptedEvents(result.snapshot).map((e) => e.type),
      });
    }
    if (result.status === "done") return res.json({ status: "done", output: result.output });
    return res.status(500).json({ status: result.status });
  });

  // Resume a persisted run with a human event.
  app.post("/agent/:id/resume", async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const snapshot = snapshots.get(id);
    if (!snapshot) return res.status(404).json({ error: "unknown run id" });

    const result = await runAgent(announceMachine, { snapshot, event: req.body?.event, executors });
    if (result.status === "done") {
      snapshots.delete(id);
      return res.json({ status: "done", output: result.output });
    }
    if (result.status === "idle") {
      snapshots.set(id, persistSnapshot(result.snapshot));
      return res.status(202).json({ status: "idle", draft: result.snapshot.context.draft });
    }
    return res.status(500).json({ status: result.status });
  });

  return app;
}

// Direct run: start the server against the mock executor. Try it with:
//   curl -sX POST localhost:3000/agent -H 'content-type: application/json' -d '{"topic":"CI speedups"}'
//   curl -sX POST localhost:3000/agent/<id>/resume -H 'content-type: application/json' -d '{"event":{"type":"APPROVE"}}'
if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  const port = Number(process.env.PORT ?? 3000);
  createApp().listen(port, () => console.log(`express-host listening on :${port}`));
}
