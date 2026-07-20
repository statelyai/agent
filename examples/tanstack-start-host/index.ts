/**
 * TanStack Start host — a server function running a state-machine agent,
 * CONTROLLED mode.
 *
 * Teaches: `runAgent` inside a TanStack Start server function. `startAgent`
 * runs the machine to idle (draft ready for review) and persists the snapshot;
 * `resumeAgent` loads it and delivers the human's APPROVE / REJECT event. The
 * snapshot IS the pause point, so the two server functions can run in different
 * requests (or different instances with a shared store).
 *
 * NOT a full TanStack Start project — `@tanstack/react-start` is not a
 * dependency of this repo, so `createServerFn` is a MINIMAL LOCAL SHIM (see
 * ./tanstack-shims). In a real app you delete the shim and
 * `import { createServerFn } from '@tanstack/react-start'`; the handler bodies
 * below are unchanged.
 *
 * The snapshot store is a module-level Map for illustration; a real deployment
 * needs a shared store keyed by run id (see ../file-snapshot-store).
 */
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
import { createServerFn } from "./tanstack-shims.js";

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
  states: { reviewing: { context: { draft: z.string() } }, published: { context: { draft: z.string() } } },
});

export const announceMachine = agentSetup.createMachine({
  id: "tanstack-announce",
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
    published: { type: "final", output: ({ context }) => ({ published: true, draft: context.draft }) },
  },
});

// ─── Host ───

const snapshots = new Map<string, Snapshot<unknown>>();

/** Keyless mock so the server functions run with no API key. */
const executors: Partial<AgentRequestExecutors> = {
  generateText: async () => ({ output: "Big news: the deploy pipeline just got faster." }),
};

/** Server function: start a run, settle idle (draft) or done. */
export const startAgent = createServerFn({ method: "POST" })
  .validator((input: unknown) => z.object({ topic: z.string() }).parse(input))
  .handler(async ({ data }) => {
    const result = await runAgent(announceMachine, { input: { topic: data.topic }, executors });
    if (result.status === "idle") {
      const id = crypto.randomUUID();
      snapshots.set(id, persistSnapshot(result.snapshot));
      const { interaction } = getStateMeta(result.snapshot);
      return {
        id,
        status: "idle" as const,
        draft: result.snapshot.context.draft,
        prompt: interaction?.label,
        acceptedEvents: getAcceptedEvents(result.snapshot).map((e) => e.type),
      };
    }
    if (result.status === "done") return { status: "done" as const, output: result.output };
    throw new Error(`agent errored: ${result.status}`);
  });

/** Server function: resume a persisted run with the human's event. */
export const resumeAgent = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    z
      .object({
        id: z.string(),
        event: z.discriminatedUnion("type", [
          z.object({ type: z.literal("APPROVE") }),
          z.object({ type: z.literal("REJECT"), reason: z.string() }),
        ]),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const snapshot = snapshots.get(data.id);
    if (!snapshot) throw new Error("unknown run id");
    const result = await runAgent(announceMachine, { snapshot, event: data.event, executors });
    if (result.status === "done") {
      snapshots.delete(data.id);
      return { status: "done" as const, output: result.output };
    }
    throw new Error(`agent did not complete: ${result.status}`);
  });
