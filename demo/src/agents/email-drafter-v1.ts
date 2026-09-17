/**
 * Email drafter v1 — ask first, draft second.
 *
 * What the MODEL owns: judging whether the request has enough detail
 * (`evaluatePrompt`) and writing the draft (`draftEmail`).
 * What the MACHINE owns: the order. Nothing is drafted until the evaluator is
 * satisfied or the human says "draft anyway"; nothing is sent until the human
 * chooses SEND from a review state; after MAX_REVISIONS rounds the only legal
 * move is SEND. A SEND with no valid recipient (possible after "draft anyway")
 * goes back to `needsMoreInfo`, v1's only way to ask. `sending` is a simulated
 * outbox.
 *
 * Every missing detail is treated the same way here: stop and ask. That is the
 * friction v2 (`./email-drafter-v2.ts`) removes, and `email-drafter-compare.ts`
 * measures.
 */
import { z } from "zod";
import { createAsyncLogic } from "xstate";
import { interactionMetaSchema, setupAgent } from "@statelyai/agent";
import { type EmailDraft, emailDraftSchema, hasRecipient } from "./email-draft";

/** Revision rounds `reviewing` allows before only SEND is legal. */
export const MAX_REVISIONS = 2;

const RECIPIENT_QUESTION = "Who should this go to? Type an email address.";

const assessmentSchema = z.object({
  satisfied: z.boolean(),
  missing: z.array(z.string()),
  questions: z.array(z.string()),
});

const agentSetup = setupAgent({
  context: z.object({
    prompt: z.string(),
    /** The evaluator's open questions, joined for the idle label. */
    questions: z.string(),
    draft: emailDraftSchema.nullable(),
    revisions: z.number(),
    failure: z.string().nullable(),
  }),
  input: z.object({ prompt: z.string() }),
  output: z.object({ sentEmails: z.array(emailDraftSchema), failure: z.string().nullable() }),
  meta: interactionMetaSchema,
  events: {
    MORE_INFO: z.object({ text: z.string() }),
    DRAFT_ANYWAY: z.object({}),
    REQUEST_CHANGES: z.object({ text: z.string() }),
    SEND: z.object({}),
  },
  isIdle: (snapshot) => snapshot.hasTag("awaiting-user"),
  requests: {
    evaluatePrompt: {
      schemas: { input: z.object({ prompt: z.string() }), output: assessmentSchema },
      model: "fast",
      system:
        "Evaluate an email drafting request. Require recipient, subject, and body details. Return missing fields and one question per gap.",
      prompt: ({ input }) => input.prompt,
    },
    draftEmail: {
      schemas: { input: z.object({ prompt: z.string() }), output: emailDraftSchema },
      model: "writer",
      system:
        "Draft a polished email from the request. Use the provided details without inventing missing essentials unless the user explicitly asked to draft anyway.",
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

export const emailDrafterV1Machine = agentSetup.createMachine({
  id: "email-drafter-v1",
  context: ({ input }) => ({
    prompt: input.prompt,
    questions: "",
    draft: null,
    revisions: 0,
    failure: null,
  }),
  initial: "evaluating",
  states: {
    evaluating: {
      invoke: {
        src: "evaluatePrompt",
        input: ({ context }) => ({ prompt: context.prompt }),
        onDone: ({ output }) => ({
          target: output.satisfied ? "drafting" : "needsMoreInfo",
          context: { questions: output.questions.join(" ") },
        }),
        onError: ({ event }) => ({
          target: "failed",
          context: { failure: `evaluatePrompt failed: ${String(event.error)}` },
        }),
      },
    },

    // Idle human-wait. Free text is MORE_INFO; the button is DRAFT_ANYWAY.
    needsMoreInfo: {
      tags: ["awaiting-user"],
      meta: {
        interaction: {
          label: "Some details are missing. {questions} Type them in, or draft anyway.",
          events: {
            MORE_INFO: { label: "Add details", style: "primary" },
            DRAFT_ANYWAY: { label: "Draft anyway" },
          },
          textEvent: "MORE_INFO",
        },
      },
      on: {
        MORE_INFO: ({ context, event }) => ({
          target: "evaluating",
          context: { prompt: `${context.prompt}\n\n${event.text}` },
        }),
        DRAFT_ANYWAY: ({ context }) => ({
          target: "drafting",
          context: { prompt: `${context.prompt}\n\nDraft anyway with reasonable assumptions.` },
        }),
      },
    },

    drafting: {
      invoke: {
        src: "draftEmail",
        input: ({ context }) => ({ prompt: context.prompt }),
        onDone: ({ context, output }) => ({
          // A spent revision budget is a different state, not a hidden guard.
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
        SEND: ({ context }) =>
          hasRecipient(context.draft)
            ? { target: "sending" }
            : { target: "needsMoreInfo", context: { questions: RECIPIENT_QUESTION } },
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
        SEND: ({ context }) =>
          hasRecipient(context.draft)
            ? { target: "sending" }
            : { target: "needsMoreInfo", context: { questions: RECIPIENT_QUESTION } },
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
