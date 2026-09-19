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
 * - `draftEmail` also returns `openQuestions`: what it drafted around. They
 *   accumulate in `clarifications` (same output field as v1) and show with
 *   the draft, so nothing v1 would have asked is lost; it just stops blocking.
 * - added: `needsSubject`. A subject-less draft cannot be sent, so SEND is not
 *   offered at all in that case — `ADD_SUBJECT` takes its place, rather than a
 *   Send button that would quietly bounce.
 */
import { z } from "zod";
import { createAsyncLogic } from "xstate";
import { setupAgent } from "@statelyai/agent";
import { type EmailDraft, emailDraftSchema, hasRecipient, hasSubject } from "./email-draft";

/** Same revision budget as v1, so the comparison changes one thing. */
export const MAX_REVISIONS = 2;

const contextSchema = z.object({
  prompt: z.string(),
  draft: emailDraftSchema.nullable(),
  /** Questions the drafter raised while drafting around gaps. Part of the output. */
  clarifications: z.array(z.string()),
  /** The last address typed that did not parse, so the re-ask can say why. */
  rejectedRecipient: z.string().nullable(),
  revisions: z.number(),
  failure: z.string().nullable(),
});

const drafted = contextSchema.extend({ draft: emailDraftSchema });

const agentSetup = setupAgent({
  context: contextSchema,
  input: z.object({ prompt: z.string() }),
  output: z.object({
    sentEmails: z.array(emailDraftSchema),
    clarifications: z.array(z.string()),
    failure: z.string().nullable(),
  }),
  events: {
    REQUEST_CHANGES: z.object({ text: z.string() }),
    SEND: z.object({}),
    ADD_SUBJECT: z.object({}),
    SUBJECT_PROVIDED: z.object({ text: z.string() }),
    RECIPIENT_PROVIDED: z.object({ text: z.string() }),
  },
  requests: {
    draftEmail: {
      schemas: {
        input: z.object({ prompt: z.string() }),
        output: emailDraftSchema.extend({
          /** Details the request left out that the draft had to assume. Empty when nothing was missing. */
          openQuestions: z.array(z.string()),
        }),
      },
      model: "writer",
      system:
        "Draft a polished email from the request. Use the details given. Pick a sensible subject if none is given, " +
        "unless the request explicitly says to leave the subject blank, in which case return an empty `subject`. " +
        "`to` must be an email address from the request; if none is given, leave `to` empty. Never invent an address. " +
        "In `openQuestions`, list one short question per detail you had to assume or leave out (recipient, subject, time, place). Empty if nothing was missing.",
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
  // Every state after `drafting` holds a draft, so narrow it there.
  states: {
    reviewing: { schemas: { context: drafted } },
    finalReview: { schemas: { context: drafted } },
    needsSubject: { schemas: { context: drafted } },
    needsRecipient: { schemas: { context: drafted } },
    sending: { schemas: { context: drafted } },
  },
});

export const emailDrafterV2Machine = agentSetup.createMachine({
  id: "email-drafter-v2",
  context: ({ input }) => ({
    prompt: input.prompt,
    draft: null,
    clarifications: [],
    rejectedRecipient: null,
    revisions: 0,
    failure: null,
  }),
  // v1 starts in `evaluating`. v2 drafts with what it has.
  initial: "drafting",
  states: {
    drafting: {
      invoke: {
        src: "draftEmail",
        input: ({ context }) => ({ prompt: context.prompt }),
        onDone: ({
          context,
          output: {
            result: { openQuestions, ...draft },
          },
        }) => ({
          target: context.revisions >= MAX_REVISIONS ? "finalReview" : "reviewing",
          context: {
            draft,
            clarifications: [
              ...context.clarifications,
              ...openQuestions.filter((question) => !context.clarifications.includes(question)),
            ],
          },
        }),
        onError: ({ event }) => ({
          target: "failed",
          context: { failure: `draftEmail failed: ${String(event.error)}` },
        }),
      },
    },

    reviewing: {
      meta: {
        interaction: {
          label: ({ context }) =>
            hasSubject(context.draft)
              ? "Send the draft, or type the changes you want."
              : "This draft has no subject line yet. Add one, or type the changes you want.",
          events: {
            SEND: { label: "Send email", style: "primary" },
            ADD_SUBJECT: { label: "Add subject", style: "primary" },
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
        // A subject-less draft is not sendable, so SEND is not offered: the
        // transition returns nothing and the interaction drops the choice.
        SEND: ({ context }) =>
          hasSubject(context.draft)
            ? { target: hasRecipient(context.draft) ? "sending" : "needsRecipient" }
            : undefined,
        ADD_SUBJECT: ({ context }) =>
          hasSubject(context.draft) ? undefined : { target: "needsSubject" },
      },
    },

    finalReview: {
      meta: {
        interaction: {
          label: ({ context }) =>
            hasSubject(context.draft)
              ? "That is the last revision I can make. Send this draft?"
              : "That is the last revision I can make. Add a subject line and it is ready to send.",
          events: {
            SEND: { label: "Send email", style: "primary" },
            ADD_SUBJECT: { label: "Add subject", style: "primary" },
          },
        },
      },
      on: {
        SEND: ({ context }) =>
          hasSubject(context.draft)
            ? { target: hasRecipient(context.draft) ? "sending" : "needsRecipient" }
            : undefined,
        ADD_SUBJECT: ({ context }) =>
          hasSubject(context.draft) ? undefined : { target: "needsSubject" },
      },
    },

    // The draft is written; only the subject is missing. Asking here costs no
    // model call and no revision, unlike routing it through REQUEST_CHANGES.
    needsSubject: {
      meta: {
        interaction: {
          label: "What should the subject line be?",
          events: { SUBJECT_PROVIDED: { label: "Use this subject", style: "primary" } },
          textEvent: "SUBJECT_PROVIDED",
        },
      },
      on: {
        // Keep the branches inline so graph tooling sees every target.
        SUBJECT_PROVIDED: ({ context, event }) =>
          event.text.trim()
            ? {
                // Back to the same review the human left; SEND stays their decision.
                target: context.revisions >= MAX_REVISIONS ? "finalReview" : "reviewing",
                context: {
                  draft: { ...context.draft, subject: event.text.trim() },
                },
              }
            : { target: "needsSubject" },
      },
    },

    // The one question v2 still asks, and only once the human has decided to
    // send. Nothing invents an address on their behalf.
    needsRecipient: {
      meta: {
        interaction: {
          // Re-asking the identical question reads as if the answer never
          // arrived, so a rejected address says what was wrong with it.
          label: ({ context }) =>
            context.rejectedRecipient
              ? `"${context.rejectedRecipient}" is not an email address. Who should this go to?`
              : "Who should this go to? Type an email address.",
          events: { RECIPIENT_PROVIDED: { label: "Use this address", style: "primary" } },
          textEvent: "RECIPIENT_PROVIDED",
        },
      },
      on: {
        // An invalid address keeps asking; the send rule is not negotiable.
        // The bad address is never written into the draft, only quoted back.
        RECIPIENT_PROVIDED: ({ context, event }) =>
          hasRecipient({ ...context.draft, to: event.text.trim() })
            ? {
                target: "sending",
                context: {
                  draft: { ...context.draft, to: event.text.trim() },
                  rejectedRecipient: null,
                },
              }
            : {
                target: "needsRecipient",
                context: { rejectedRecipient: event.text.trim().slice(0, 40) },
              },
      },
    },

    sending: {
      invoke: {
        src: "sendEmail",
        input: ({ context }) => ({ draft: context.draft }),
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
        clarifications: context.clarifications,
        failure: null,
      }),
    },
    failed: {
      type: "final",
      output: ({ context }) => ({
        sentEmails: [],
        clarifications: context.clarifications,
        failure: context.failure ?? "unknown failure",
      }),
    },
  },
});
