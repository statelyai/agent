/**
 * Email drafter v2 — draft first, check at the boundary.
 *
 * The workflow change proposed after watching v1 run: v1 stops to ask about
 * every missing detail before drafting. v2 drafts with whatever it has and
 * moves the one mandatory check, a valid recipient, to the moment it matters:
 * SEND. The human still reviews every draft; SEND is still a human action.
 *
 * Diff against v1 (`./email-drafter-v1.ts`):
 * - removed: `evaluating`, `needsMoreInfo`, the `evaluatePrompt` request
 * - added: `needsRecipient`, reached only from a SEND with no valid address
 * - SEND branches on `hasRecipient(draft)` instead of always sending
 * - `draftEmail` is told to leave `to` empty rather than invent an address
 */
import { z } from "zod";
import { createAsyncLogic } from "xstate";
import { interactionMetaSchema, setupAgent } from "@statelyai/agent";
import { type EmailDraft, emailDraftSchema, hasRecipient } from "./email-draft";

/** Same revision budget as v1, so the comparison changes one thing. */
export const MAX_REVISIONS = 2;

const agentSetup = setupAgent({
  context: z.object({
    prompt: z.string(),
    draft: emailDraftSchema.nullable(),
    revisions: z.number(),
    failure: z.string().nullable(),
  }),
  input: z.object({ prompt: z.string() }),
  output: z.object({ sentEmails: z.array(emailDraftSchema), failure: z.string().nullable() }),
  meta: interactionMetaSchema,
  events: {
    REQUEST_CHANGES: z.object({ text: z.string() }),
    SEND: z.object({}),
    RECIPIENT_PROVIDED: z.object({ text: z.string() }),
  },
  isIdle: (snapshot) => snapshot.hasTag("awaiting-user"),
  requests: {
    draftEmail: {
      schemas: { input: z.object({ prompt: z.string() }), output: emailDraftSchema },
      model: "writer",
      system:
        "Draft a polished email from the request. Use the details given. Pick a sensible subject if none is given. " +
        "`to` must be an email address from the request; if none is given, leave `to` empty. Never invent an address.",
      prompt: ({ input }) => input.prompt,
    },
  },
  actors: {
    sendEmail: createAsyncLogic<{ sent: boolean }, { draft: EmailDraft }>({
      run: async ({ input }) => {
        void input.draft;
        return { sent: true };
      },
    }),
  },
});

export const emailDrafterV2Machine = agentSetup.createMachine({
  id: "email-drafter-v2",
  context: ({ input }) => ({ prompt: input.prompt, draft: null, revisions: 0, failure: null }),
  // v1 starts in `evaluating`. v2 drafts with what it has.
  initial: "drafting",
  states: {
    drafting: {
      invoke: {
        src: "draftEmail",
        input: ({ context }) => ({ prompt: context.prompt }),
        onDone: ({ context, output }) => ({
          target: context.revisions >= MAX_REVISIONS ? "finalReview" : "reviewing",
          context: { draft: output },
        }),
        onError: ({ event }) => ({
          target: "failed",
          context: { failure: `draftEmail failed: ${String(event.error)}` },
        }),
      },
    },

    reviewing: {
      tags: ["awaiting-user"],
      meta: {
        interaction: {
          label: "Send the draft, or type the changes you want.",
          events: {
            SEND: { label: "Send email", style: "primary" },
            REQUEST_CHANGES: { label: "Request changes" },
          },
          textEvent: "REQUEST_CHANGES",
        },
      },
      on: {
        REQUEST_CHANGES: ({ context, event }) => ({
          target: "drafting",
          context: {
            revisions: context.revisions + 1,
            prompt: `${context.prompt}\n\nRevision request: ${event.text}`,
          },
        }),
        // The mandatory check lives at the sending boundary, not before drafting.
        SEND: ({ context }) => ({
          target: hasRecipient(context.draft) ? "sending" : "needsRecipient",
        }),
      },
    },

    finalReview: {
      tags: ["awaiting-user"],
      meta: {
        interaction: {
          label: "That is the last revision I can make. Send this draft?",
          events: { SEND: { label: "Send email", style: "primary" } },
        },
      },
      on: {
        SEND: ({ context }) => ({
          target: hasRecipient(context.draft) ? "sending" : "needsRecipient",
        }),
      },
    },

    // The one question v2 still asks, and only once the human has decided to
    // send. Nothing invents an address on their behalf.
    needsRecipient: {
      tags: ["awaiting-user"],
      meta: {
        interaction: {
          label: "Who should this go to? Type an email address.",
          events: { RECIPIENT_PROVIDED: { label: "Use this address", style: "primary" } },
          textEvent: "RECIPIENT_PROVIDED",
        },
      },
      on: {
        RECIPIENT_PROVIDED: ({ context, event }) => {
          const draft = context.draft ? { ...context.draft, to: event.text.trim() } : null;
          // An invalid address keeps asking; the send rule is not negotiable.
          return hasRecipient(draft)
            ? { target: "sending", context: { draft } }
            : { target: "needsRecipient" };
        },
      },
    },

    sending: {
      invoke: {
        src: "sendEmail",
        input: ({ context }) => ({ draft: context.draft! }),
        onDone: { target: "sent" },
        onError: ({ event }) => ({
          target: "failed",
          context: { failure: `sendEmail failed: ${String(event.error)}` },
        }),
      },
    },

    sent: {
      type: "final",
      output: ({ context }) => ({
        sentEmails: context.draft ? [context.draft] : [],
        failure: null,
      }),
    },
    failed: {
      type: "final",
      output: ({ context }) => ({ sentEmails: [], failure: context.failure ?? "unknown failure" }),
    },
  },
});
