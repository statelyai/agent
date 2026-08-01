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
 * A real, bootable Start app: `pnpm --dir examples/tanstack-start-host dev`
 * serves `src/routes/index.tsx`, which calls the two server functions below
 * over Start's RPC endpoint. This file holds the machine and the server
 * functions; the route is only the browser half.
 *
 * The snapshot store is a module-level Map for illustration; a real deployment
 * needs a shared store keyed by run id (see ../file-snapshot-store).
 */
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import {
  createScriptedExecutors,
  getAcceptedEvents,
  getStateMeta,
  persistSnapshot,
  runAgent,
  setupAgent,
  type AgentRequestExecutors,
  type AgentTextRequest,
} from "@statelyai/agent";
import { createAiSdkExecutors, defineModels } from "@statelyai/agent/ai-sdk";
import type { Snapshot } from "xstate";
import { createServerFn } from "@tanstack/react-start";

// ─── The machine: draft → idle review → publish ───

const contextSchema = z.object({
  topic: z.string(),
  draft: z.string().nullable(),
});

/** The machine's event payloads. Single source: fed to `setupAgent` below AND to `eventUnionSchema` for the wire schema, so the two cannot drift. */
const eventSchemas = {
  APPROVE: z.object({}),
  REJECT: z.object({ reason: z.string() }),
};

/**
 * Builds the wire schema (`{ type, ...payload }`) for a `setupAgent({ events })`
 * map. `setupAgent` keeps the payload schemas keyed by type (`agentSetup.schemas.events`),
 * which is what the runtime needs; a host that validates an inbound event body
 * wants the discriminated union of the same schemas — this derives one from the other.
 */
function eventUnionSchema<TEvents extends Record<string, z.ZodObject>>(events: TEvents) {
  const members = Object.entries(events).map(([type, schema]) =>
    schema.extend({ type: z.literal(type) }),
  ) as unknown as [z.ZodObject, ...z.ZodObject[]];

  return z.discriminatedUnion("type", members) as unknown as z.ZodType<
    { [K in keyof TEvents & string]: { type: K } & z.infer<TEvents[K]> }[keyof TEvents & string]
  >;
}

/** APPROVE | REJECT, derived from `eventSchemas` — use it to validate inbound event bodies. */
export const announceEventSchema = eventUnionSchema(eventSchemas);

const agentSetup = setupAgent({
  context: contextSchema,
  input: z.object({ topic: z.string() }),
  output: z.object({ published: z.boolean(), draft: z.string() }),
  meta: z.object({ interaction: z.object({ label: z.string() }).optional() }),
  events: eventSchemas,
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
  id: "tanstack-announce",
  context: ({ input }) => ({ topic: input.topic, draft: null }),
  initial: "drafting",
  states: {
    drafting: {
      invoke: {
        src: "writeDraft",
        input: ({ context }) => ({ topic: context.topic }),
        onDone: ({ output }) => ({
          target: "reviewing",
          context: { draft: output },
        }),
      },
    },
    reviewing: {
      tags: ["awaiting-review"],
      meta: {
        interaction: { label: "Approve to publish, or reject with a reason." },
      },
      on: {
        APPROVE: { target: "published" },
        REJECT: ({ context, event }) => ({
          target: "drafting",
          context: {
            topic: `${context.topic}\nRevision requested: ${event.reason}`,
          },
        }),
      },
    },
    published: {
      type: "final",
      output: ({ context }) => ({ published: true, draft: context.draft }),
    },
  },
});

// ─── Host ───

const snapshots = new Map<string, Snapshot<unknown>>();

/** The machine's `writeDraft` request asks for model `"writer"`; map it here. */
const models = defineModels({ writer: openai("gpt-5.4-mini") });

/** The scripted stand-in for `writeDraft`, so a keyless `pnpm dev` still runs. */
const writeDraft = (request: AgentTextRequest): string => {
  const topic = (request.prompt ?? "").replace(/^Write a short announcement about:\s*/, "");
  return `Big news: ${topic.split("\n")[0]} just shipped.`;
};

/**
 * Real models when `OPENAI_API_KEY` is set, scripted playback otherwise.
 *
 * Fresh executors per call: the scripted queues are consumed FIFO, so a
 * module-level singleton would run dry on the second run. Four answers so a
 * REJECT (which sends the machine back to `drafting`) still has one waiting.
 */
function resolveExecutors(): Partial<AgentRequestExecutors> {
  return process.env.OPENAI_API_KEY
    ? createAiSdkExecutors({ models })
    : createScriptedExecutors({ text: [writeDraft, writeDraft, writeDraft, writeDraft] });
}

type Settled =
  | {
      id: string;
      status: "idle";
      draft: string | null;
      prompt: string | undefined;
      acceptedEvents: string[];
    }
  | { status: "done"; output: { published: boolean; draft: string } };

/**
 * Fold a settled run into the wire shape the route renders. An idle run stores
 * (or restores) its snapshot under `id` — that snapshot IS the pause point, so
 * the next request can be served by a different instance.
 */
function settle(result: Awaited<ReturnType<typeof runAgent<typeof announceMachine>>>, id: string) {
  if (result.status === "idle") {
    snapshots.set(id, persistSnapshot(result.snapshot));
    const { interaction } = getStateMeta(result.snapshot);
    return {
      id,
      status: "idle" as const,
      draft: result.snapshot.context.draft,
      prompt: interaction?.label,
      acceptedEvents: getAcceptedEvents(result.snapshot).map((e) => e.type),
    } satisfies Settled;
  }
  if (result.status === "done") {
    snapshots.delete(id);
    return { status: "done" as const, output: result.output } satisfies Settled;
  }
  throw new Error(`agent errored: ${result.status}`);
}

/** Server function: start a run, settle idle (draft ready for review) or done. */
export const startAgent = createServerFn({ method: "POST" })
  .validator((input: unknown) => z.object({ topic: z.string() }).parse(input))
  .handler(async ({ data }): Promise<Settled> => {
    const result = await runAgent(announceMachine, {
      input: { topic: data.topic },
      executors: resolveExecutors(),
    });
    return settle(result, crypto.randomUUID());
  });

/**
 * Server function: resume a persisted run with the human's event. APPROVE
 * finishes it; REJECT redrafts and comes back idle under the same run id.
 */
export const resumeAgent = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    z.object({ id: z.string(), event: announceEventSchema }).parse(input),
  )
  .handler(async ({ data }): Promise<Settled> => {
    const snapshot = snapshots.get(data.id);
    if (!snapshot) throw new Error("unknown run id");
    const result = await runAgent(announceMachine, {
      snapshot,
      event: data.event,
      executors: resolveExecutors(),
    });
    return settle(result, data.id);
  });
