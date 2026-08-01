/**
 * Next.js App Router host — a route handler running a state-machine agent,
 * CONTROLLED mode. File layout mirrors a real app: this lives at
 * `app/api/agent/route.ts`, and the resume handler at
 * `app/api/agent/[id]/resume/route.ts`.
 *
 * Teaches: `runAgent` inside a Next route handler (or a Server Action — same
 * body). POST runs the machine to idle (draft ready) or done; the persisted
 * snapshot is the entire pause point, so human-in-the-loop works across the
 * stateless request boundary.
 *
 * A real workspace package depending on real `next`, so `NextRequest` and
 * `NextResponse` below are the published types and CI catches Next API drift.
 * Drop these two files into `app/api/agent/` of an actual app and they run.
 * `pnpm dev` boots the package on port 3005; ../../page.tsx drives this flow
 * from a browser.
 *
 * The snapshot store here is a module-level Map for illustration. A real
 * deployment (serverless, multiple instances) needs a shared store — Redis, a
 * DB row, a KV namespace — keyed by run id. See ../file-snapshot-store.
 */
import { z } from "zod";
import {
  getAcceptedEvents,
  getStateMeta,
  persistSnapshot,
  runAgent,
  setupAgent,
} from "@statelyai/agent";
import type { Snapshot } from "xstate";
import { NextResponse, type NextRequest } from "next/server";
import { models, resolveExecutors, maybeCreateRunInspection } from "../../../agent-runtime";

// ─── The machine: draft → idle review → publish ───

const contextSchema = z.object({ topic: z.string(), draft: z.string().nullable() });

const agentSetup = setupAgent({
  models,
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

export const announceMachine = agentSetup.createMachine({
  id: "next-announce",
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

// Shared, module-scoped store — imported by the resume route too. Kept here
// inline for a single-file read. Executors and inspection live in
// ../../../agent-runtime.ts, which both handlers share.
export const snapshots = new Map<string, Snapshot<unknown>>();

/** POST /api/agent — start a run; settle idle (draft) or done. */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const body = (await request.json().catch(() => ({}))) as { topic?: string };
  const result = await runAgent(announceMachine, {
    input: { topic: body.topic ?? "the new deploy pipeline" },
    executors: resolveExecutors(),
    inspect: await maybeCreateRunInspection(),
  });

  if (result.status === "idle") {
    const id = crypto.randomUUID();
    snapshots.set(id, persistSnapshot(result.snapshot));
    const { interaction } = getStateMeta(result.snapshot);
    return NextResponse.json(
      {
        id,
        status: "idle",
        draft: result.snapshot.context.draft,
        prompt: interaction?.label,
        acceptedEvents: getAcceptedEvents(result.snapshot).map((e) => e.type),
      },
      { status: 202 },
    );
  }
  if (result.status === "done") return NextResponse.json({ status: "done", output: result.output });
  return NextResponse.json({ status: result.status }, { status: 500 });
}
