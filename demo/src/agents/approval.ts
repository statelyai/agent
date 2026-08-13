/**
 * Human approval — the model drafts, a person decides.
 *
 * What the MODEL owns: writing the draft (`writeDraft`).
 * What the MACHINE owns: the gate. `reviewing` has no invoke, so runAgent
 * settles idle and waits for a human `APPROVE` / `REJECT` event — the model can
 * never publish on its own. REJECT feeds the reason back into a fresh draft;
 * APPROVE publishes.
 *
 * A direct port of examples/human-in-the-loop: the idle snapshot round-trips
 * through a persisted snapshot on every resume, so the two halves can run in
 * different requests.
 */
import { z } from "zod";
import { setupAgent } from "@statelyai/agent";

const agentSetup = setupAgent({
  context: z.object({ topic: z.string(), draft: z.string().nullable() }),
  input: z.object({ topic: z.string() }),
  output: z.object({ published: z.boolean(), draft: z.string() }),
  meta: z.object({ interaction: z.object({ label: z.string() }).optional() }),
  events: {
    APPROVE: z.object({}),
    REJECT: z.object({ reason: z.string() }),
  },
  isIdle: (snapshot) => snapshot.hasTag("awaiting-review"),
  requests: {
    writeDraft: {
      schemas: { input: z.object({ topic: z.string() }), output: z.string() },
      model: "writer",
      system: "You write short, punchy internal announcements in two or three sentences.",
      prompt: ({ input }) => `Write a short announcement about: ${input.topic}`,
    },
  },
  // `reviewing`/`published` are reachable only after a draft exists — narrow it.
  states: {
    reviewing: { context: { draft: z.string() } },
    published: { context: { draft: z.string() } },
  },
});

export const approvalMachine = agentSetup.createMachine({
  id: "approval",
  context: ({ input }) => ({ topic: input.topic, draft: null }),
  initial: "drafting",
  states: {
    drafting: {
      invoke: {
        src: "writeDraft",
        input: ({ context }) => ({ topic: context.topic }),
        // Object-form transition: static target (draws the edge), dynamic context.
        onDone: { target: "reviewing", context: ({ output }) => ({ draft: output }) },
        onError: { target: "failed" },
      },
    },
    // Idle human-wait: no invoke. runAgent settles here; the host shows
    // `meta.interaction` and the events from getAcceptedEvents.
    reviewing: {
      tags: ["awaiting-review"],
      meta: {
        interaction: { label: "Review the draft: approve to publish, or reject with a reason." },
      },
      on: {
        APPROVE: { target: "published" },
        REJECT: {
          target: "drafting",
          context: ({ context, event }) => ({
            topic: `${context.topic}\nRevision requested: ${event.reason}`,
          }),
        },
      },
    },
    published: {
      type: "final",
      output: ({ context }) => ({ published: true, draft: context.draft }),
    },
    failed: {
      type: "final",
      output: ({ context }) => ({ published: false, draft: context.draft ?? "" }),
    },
  },
});
