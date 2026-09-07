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
 * DB row, a KV namespace — keyed by run id. See examples/file-snapshot-store.
 */
import { z } from "zod";
import { getInteraction, interactionMetaSchema, runAgent, setupAgent } from "@statelyai/agent";
import type { Snapshot } from "xstate";
import { NextResponse, type NextRequest } from "next/server";
import { models, resolveExecutors, maybeCreateRunInspection } from "../../../agent-runtime";

// ─── The machine: draft → idle review → publish, with a rejection budget ───

/** How many REJECTs the reviewer gets before the run ends unpublished. */
export const MAX_REJECTIONS = 2;

const contextSchema = z.object({
  topic: z.string(),
  draft: z.string().nullable(),
  /** REJECTs used so far; bounds the reviewing → drafting loop. */
  rejections: z.number(),
  /** The latest rejection reason, or the failure that ended the run. */
  reason: z.string().nullable(),
});

const agentSetup = setupAgent({
  models,
  context: contextSchema,
  input: z.object({ topic: z.string() }),
  output: z.object({
    published: z.boolean(),
    draft: z.string().nullable(),
    reason: z.string().nullable(),
  }),
  meta: interactionMetaSchema,
  events: { APPROVE: z.object({}), REJECT: z.object({ reason: z.string().min(1) }) },
  requests: {
    writeDraft: {
      schemas: { input: z.object({ topic: z.string() }), output: z.string() },
      model: "writer",
      prompt: ({ input }) => `Write a short announcement about: ${input.topic}`,
    },
  },
  states: {
    reviewing: { schemas: { context: contextSchema.extend({ draft: z.string() }) } },
    published: { schemas: { context: contextSchema.extend({ draft: z.string() }) } },
  },
});

/** The event payload schemas, so the resume route can validate a wire event. */
export const eventSchemas = agentSetup.schemas.events;

export const announceMachine = agentSetup.createMachine({
  id: "next-announce",
  context: ({ input }) => ({ topic: input.topic, draft: null, rejections: 0, reason: null }),
  initial: "drafting",
  states: {
    drafting: {
      invoke: {
        src: "writeDraft",
        input: ({ context }) => ({ topic: context.topic }),
        onDone: ({ output }) => ({ target: "reviewing", context: { draft: output } }),
        onError: ({ event }) => ({
          target: "failed",
          context: { reason: `writeDraft failed: ${String(event.error)}` },
        }),
      },
    },
    reviewing: {
      tags: ["awaiting-review"],
      meta: {
        interaction: {
          label: "Approve to publish, or reject with a reason.",
          events: {
            APPROVE: { label: "Publish", style: "primary" },
            REJECT: { label: "Reject with a reason", style: "danger" },
          },
          textEvent: "REJECT",
        },
      },
      on: {
        APPROVE: { target: "published" },
        // Bounded, not an open loop: the counter is compared to a constant, and
        // the last rejection ends the run instead of asking for draft four.
        REJECT: ({ context, event }) =>
          context.rejections + 1 >= MAX_REJECTIONS
            ? {
                target: "rejected",
                context: { rejections: context.rejections + 1, reason: event.reason },
              }
            : {
                target: "drafting",
                context: {
                  rejections: context.rejections + 1,
                  reason: event.reason,
                  topic: `${context.topic}\nRevision requested: ${event.reason}`,
                },
              },
      },
    },
    published: {
      type: "final",
      output: ({ context }) => ({ published: true, draft: context.draft, reason: null }),
    },
    rejected: {
      type: "final",
      output: ({ context }) => ({
        published: false,
        draft: context.draft,
        reason: context.reason,
      }),
    },
    failed: {
      type: "final",
      output: ({ context }) => ({ published: false, draft: null, reason: context.reason }),
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
    snapshots.set(id, result.persist());
    // One call renders the pause: the label, the choices XState will currently
    // accept, and the event free text belongs to.
    const interaction = getInteraction(result.snapshot);
    return NextResponse.json(
      {
        id,
        status: "idle",
        draft: result.snapshot.context.draft,
        interaction,
      },
      { status: 202 },
    );
  }
  if (result.status === "done") return NextResponse.json({ status: "done", output: result.output });
  return NextResponse.json({ status: result.status }, { status: 500 });
}
