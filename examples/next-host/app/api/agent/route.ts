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
 * NOT a full Next project — Next is not a dependency of this repo, so the web
 * `Request`/`Response` types below are MINIMAL LOCAL SHIMS (see ./next-shims)
 * so this file typechecks standalone. In a real app you delete those shims: the
 * globals are already typed, and you'd typically return `NextResponse.json(...)`
 * from `next/server`. Everything else is unchanged.
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
  type AgentRequestExecutors,
} from "@statelyai/agent";
import type { Snapshot } from "xstate";
import { json, type RouteRequest, type RouteResponse } from "../../../next-shims.js";

// ─── The machine: draft → idle review → publish ───

const contextSchema = z.object({ topic: z.string(), draft: z.string().nullable() });

const agentSetup = setupAgent({
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

// Shared, module-scoped store + executors — see ./store.ts (imported by the
// resume route too). Kept here inline for a single-file read.
export const snapshots = new Map<string, Snapshot<unknown>>();

/** Keyless mock so the handler runs with no API key. Swap for createAiSdkExecutors. */
export const executors: Partial<AgentRequestExecutors> = {
  generateText: async () => ({ output: "Big news: the deploy pipeline just got faster." }),
};

/** POST /api/agent — start a run; settle idle (draft) or done. */
export async function POST(request: RouteRequest): Promise<RouteResponse> {
  const body = (await request.json().catch(() => ({}))) as { topic?: string };
  const result = await runAgent(announceMachine, {
    input: { topic: body.topic ?? "the new deploy pipeline" },
    executors,
  });

  if (result.status === "idle") {
    const id = crypto.randomUUID();
    snapshots.set(id, persistSnapshot(result.snapshot));
    const { interaction } = getStateMeta(result.snapshot);
    return json(
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
  if (result.status === "done") return json({ status: "done", output: result.output });
  return json({ status: result.status }, { status: 500 });
}
