/**
 * Email drafter v1 — ask first, draft second.
 *
 * What JEV owns: judging whether the request has enough detail
 * (`evaluatePrompt`). A completeness check is a typed judgment over text the
 * machine already holds, not a generation, so it goes to TypeSafe's System One
 * model: one `noul` for "enough to draft from?" plus one `noul` per required
 * detail, in one call. Code turns the probabilities into `missing` against
 * `ASSESSMENT_THRESHOLD`.
 * What the MODEL owns: wording the follow-up questions (`writeFollowUps`, run
 * only when something is missing) and writing the draft (`draftEmail`).
 * What the MACHINE owns: the order. Nothing is drafted until the evaluator is
 * satisfied or the human says "draft anyway"; nothing is sent until the human
 * chooses SEND from a review state; after MAX_REVISIONS rounds the only legal
 * move is SEND. A SEND with no valid recipient (possible after "draft anyway")
 * goes back to `needsMoreInfo`, v1's only way to ask, and so does a SEND with
 * no subject line. `sending` is a simulated outbox.
 *
 * Every missing detail is treated the same way here: stop and ask. That is the
 * friction v2 (`./email-drafter-v2.ts`) removes, and `email-drafter-compare.ts`
 * measures.
 */
import { z } from "zod";
import { createAsyncLogic } from "xstate";
import { noul, type TypeSafeClient } from "@typesafe-ai/sdk";
import { setupAgent } from "@statelyai/agent";
import { createSystemOneLogic } from "@statelyai/agent/typesafe";
import { type EmailDraft, emailDraftSchema, hasRecipient, hasSubject } from "./email-draft";

/** Revision rounds `reviewing` allows before only SEND is legal. */
export const MAX_REVISIONS = 2;

const RECIPIENT_QUESTION = "Who should this go to? Type an email address.";
const SUBJECT_QUESTION = "What should the subject line be?";

/**
 * What a request must state before v1 drafts, keyed by the name `missing`
 * reports. The descriptions are the evidence Jev reads (`requiredDetails`).
 * The recipient is an address because v1's send rule needs one.
 */
export const REQUIRED_DETAILS = {
  recipient: "The email address the email goes to.",
  subject: "What the email is about, clearly enough to write a subject line.",
  body: "The message or facts the email must convey.",
} as const;

export type RequiredDetail = keyof typeof REQUIRED_DETAILS;

/** A detail counts as stated, and the request as complete, at or above this probability. */
export const ASSESSMENT_THRESHOLD = 0.5;

/**
 * The prompt check as one Jev call: the request and the required details are
 * the state; `satisfied` plus one `noul` per detail are the questions.
 * `client` is injected by tests; omitted, the SDK reads `TYPESAFE_API_KEY`.
 */
export function createEvaluatePrompt(client?: TypeSafeClient) {
  return createSystemOneLogic({
    client,
    state: (input: { prompt: string }) => ({
      request: input.prompt,
      requiredDetails: REQUIRED_DETAILS,
    }),
    questions: () => ({
      satisfied: noul(
        "Does `request` give enough to draft the email without inventing any detail listed in `requiredDetails`?",
        {
          true: "Every required detail is stated or plainly implied.",
          false: "At least one required detail would have to be guessed.",
        },
      ),
      ...(Object.fromEntries(
        Object.keys(REQUIRED_DETAILS).map((detail) => [
          detail,
          noul(`Does \`request\` state the ${detail} described in \`requiredDetails.${detail}\`?`),
        ]),
      ) as Record<RequiredDetail, ReturnType<typeof noul>>),
    }),
  });
}

const contextSchema = z.object({
  prompt: z.string(),
  /** The required details Jev read as missing, for `clarifying` to ask about. */
  missing: z.array(z.string()),
  /** The evaluator's open questions, joined for the idle label. */
  questions: z.string(),
  /** Every question the workflow raised, in order. Part of the output. */
  clarifications: z.array(z.string()),
  draft: emailDraftSchema.nullable(),
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
    MORE_INFO: z.object({ text: z.string() }),
    DRAFT_ANYWAY: z.object({}),
    REQUEST_CHANGES: z.object({ text: z.string() }),
    SEND: z.object({}),
  },
  requests: {
    // The follow-up questions are prose the human reads, so they stay a text
    // request. `clarifying` runs it only when the judgment found a gap.
    writeFollowUps: {
      schemas: {
        input: z.object({ prompt: z.string(), missing: z.array(z.string()) }),
        output: z.object({ questions: z.array(z.string()) }),
      },
      model: "fast",
      system:
        "An email drafting request is missing details. Write one short question to the user per missing detail.",
      prompt: ({ input }) =>
        `Request:\n${input.prompt}\n\nMissing: ${input.missing.join(", ") || "(unclear what is missing)"}`,
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
    evaluatePrompt: createEvaluatePrompt(),
  },
  // Every state after `drafting` holds a draft, so narrow it there.
  states: {
    reviewing: { schemas: { context: drafted } },
    finalReview: { schemas: { context: drafted } },
    sending: { schemas: { context: drafted } },
  },
});

export const emailDrafterV1Machine = agentSetup.createMachine({
  id: "email-drafter-v1",
  context: ({ input }) => ({
    prompt: input.prompt,
    missing: [],
    questions: "",
    clarifications: [],
    draft: null,
    revisions: 0,
    failure: null,
  }),
  initial: "evaluating",
  states: {
    // A Jev judgment: probabilities in, `missing` computed here against the
    // threshold. Complete → draft; anything missing → word the questions.
    evaluating: {
      invoke: {
        src: "evaluatePrompt",
        input: ({ context }) => ({ prompt: context.prompt }),
        onDone: ({ output: { answers } }) => {
          const missing = (Object.keys(REQUIRED_DETAILS) as RequiredDetail[]).filter(
            (detail) => answers[detail].noul < ASSESSMENT_THRESHOLD,
          );
          return answers.satisfied.noul >= ASSESSMENT_THRESHOLD && missing.length === 0
            ? { target: "drafting", context: { missing, questions: "" } }
            : { target: "clarifying", context: { missing } };
        },
        onError: ({ event }) => ({
          target: "failed",
          context: { failure: `evaluatePrompt failed: ${String(event.error)}` },
        }),
      },
    },

    // Only reached when something is missing: the text model words the
    // follow-up questions. Failing to word them still asks the human.
    clarifying: {
      invoke: {
        src: "writeFollowUps",
        input: ({ context }) => ({ prompt: context.prompt, missing: context.missing }),
        onDone: ({ context, output: { result: output } }) => ({
          target: "needsMoreInfo",
          context: {
            questions: output.questions.join(" "),
            // The evaluator re-asks about a gap the user did not fill; the
            // output lists each distinct question once.
            clarifications: [
              ...context.clarifications,
              ...output.questions.filter((question) => !context.clarifications.includes(question)),
            ],
          },
        }),
        onError: ({ context }) => ({
          target: "needsMoreInfo",
          context: { questions: `Missing: ${context.missing.join(", ") || "some details"}.` },
        }),
      },
    },

    // Idle human-wait. Free text is MORE_INFO; the button is DRAFT_ANYWAY.
    needsMoreInfo: {
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
        onDone: ({ context, output: { result: output } }) => ({
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
        // Keep every possible target visible in this expression. Hiding the
        // branch in a helper makes the transition opaque to graph tooling.
        SEND: ({ context }) =>
          !hasRecipient(context.draft)
            ? {
                target: "needsMoreInfo",
                context: {
                  questions: RECIPIENT_QUESTION,
                  clarifications: context.clarifications.includes(RECIPIENT_QUESTION)
                    ? context.clarifications
                    : [...context.clarifications, RECIPIENT_QUESTION],
                },
              }
            : !hasSubject(context.draft)
              ? {
                  target: "needsMoreInfo",
                  context: {
                    questions: SUBJECT_QUESTION,
                    clarifications: context.clarifications.includes(SUBJECT_QUESTION)
                      ? context.clarifications
                      : [...context.clarifications, SUBJECT_QUESTION],
                  },
                }
              : { target: "sending" },
      },
    },

    finalReview: {
      meta: {
        interaction: {
          label: "That is the last revision I can make. Send this draft?",
          events: { SEND: { label: "Send email", style: "primary" } },
        },
      },
      on: {
        SEND: ({ context }) =>
          !hasRecipient(context.draft)
            ? {
                target: "needsMoreInfo",
                context: {
                  questions: RECIPIENT_QUESTION,
                  clarifications: context.clarifications.includes(RECIPIENT_QUESTION)
                    ? context.clarifications
                    : [...context.clarifications, RECIPIENT_QUESTION],
                },
              }
            : !hasSubject(context.draft)
              ? {
                  target: "needsMoreInfo",
                  context: {
                    questions: SUBJECT_QUESTION,
                    clarifications: context.clarifications.includes(SUBJECT_QUESTION)
                      ? context.clarifications
                      : [...context.clarifications, SUBJECT_QUESTION],
                  },
                }
              : { target: "sending" },
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
