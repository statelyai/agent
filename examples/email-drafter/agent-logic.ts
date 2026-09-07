/**
 * The email drafter's agent logic: schemas, models, requests, actors, the agent
 * setup, and the machine itself. Everything a host needs, in one file and with
 * nothing host-flavored in it.
 *
 * Every framework host in `examples/` (Mastra, Flue, LangChain, Cloudflare, the
 * inspector, the CLI in `./index.ts`) imports this module and nothing else from
 * the example. Each state that needs the human carries the library's own
 * `meta.interaction` descriptor — validated by the shipped
 * `interactionMetaSchema` and read back with `getInteraction` — so hosts render
 * the conversation generically and never hardcode state names.
 *
 * Flow: prompting → evaluating → (needsMoreInfo)? → drafting → reviewing →
 * sending → sent → (another | done), with `failed` for a request that errors.
 * After MAX_REVISIONS revision rounds, drafting lands in `finalReview`, which
 * accepts SEND and nothing else — the bound is a state, not a hidden guard.
 */
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { createAsyncLogic } from "xstate";
import { defineModels } from "@statelyai/agent/ai-sdk";
import {
  type AgentInteraction,
  type AgentMessage,
  type EventOf,
  assistantMessage,
  createAgentSchemas,
  createTextLogic,
  interactionMetaSchema,
  setupAgent,
  userMessage,
} from "@statelyai/agent";

/** How many revision rounds `reviewing` allows before only SEND is legal. */
export const MAX_REVISIONS = 2;

const promptAssessmentSchema = z.object({
  satisfied: z.boolean(),
  missing: z.array(z.string()),
  questions: z.array(z.string()),
});

const emailDraftSchema = z.object({
  to: z.string(),
  subject: z.string(),
  body: z.string(),
});

type EmailDraft = z.infer<typeof emailDraftSchema>;

const contextSchema = z.object({
  prompt: z.string(),
  assessment: promptAssessmentSchema.nullable(),
  draft: emailDraftSchema.nullable(),
  sentEmails: z.array(emailDraftSchema),
  // `messagesSchema` is the shipped validator, but nesting it in a zod object
  // erases the element type, so the context schema keeps a typed `z.custom`.
  messages: z.custom<AgentMessage[]>((value) => Array.isArray(value)),
  /** Revision rounds used so far; bounds the reviewing → drafting loop. */
  revisions: z.number(),
  /** Why the run failed, when it did. `null` on the happy path. */
  failure: z.string().nullable(),
});

// Every event is a fact from the human. The three that carry free text use the
// field name `text`, because that is what `eventFromInteraction(snapshot, {
// text })` produces for the state's declared `textEvent`.
const eventSchemas = {
  PROMPT_SUBMITTED: z.object({ text: z.string() }),
  MORE_INFO: z.object({ text: z.string() }),
  DRAFT_ANYWAY: z.object({}),
  REQUEST_CHANGES: z.object({ text: z.string() }),
  SEND: z.object({}),
  ANOTHER: z.object({}),
  END: z.object({}),
};

const outputSchema = z.object({
  sentEmails: z.array(emailDraftSchema),
  failure: z.string().nullable(),
});

export const models = defineModels({
  promptEvaluator: openai("gpt-5.4-mini"),
  emailDrafter: openai("gpt-5.4-mini"),
});

export const evaluatePrompt = createTextLogic({
  schemas: {
    input: z.object({ prompt: z.string() }),
    output: promptAssessmentSchema,
  },
  name: "evaluatePrompt",
  model: "promptEvaluator",
  system:
    "Evaluate an email drafting request. Require recipient, subject, and body details. Return missing fields and one question per gap.",
  prompt: ({ input }) => input.prompt,
});

export const draftEmail = createTextLogic({
  schemas: {
    input: z.object({
      prompt: z.string(),
      messages: z.custom<AgentMessage[]>((value) => Array.isArray(value)),
    }),
    output: emailDraftSchema,
  },
  name: "draftEmail",
  model: "emailDrafter",
  system:
    "Draft a polished email from the request. Use the provided details without inventing missing essentials unless the user explicitly asked to draft anyway.",
  messages: ({ input }) => [...input.messages, userMessage(input.prompt)],
});

export const emailDrafterSchemas = createAgentSchemas({
  context: contextSchema,
  events: eventSchemas,
  output: outputSchema,
  // The library's own interaction protocol, not a per-machine restatement of
  // it: `label` / `events` / `textEvent`, read back with `getInteraction`.
  meta: interactionMetaSchema,
});

export const emailDrafterActors = {
  sendEmail: createAsyncLogic<{ sent: boolean }, { draft: EmailDraft }>({
    run: async ({ input }) => {
      void input.draft;
      return { sent: true };
    },
  }),
  evaluatePrompt,
  draftEmail,
};

const agentSetup = setupAgent({
  schemas: emailDrafterSchemas,
  models,
  actors: emailDrafterActors,
});

export const emailDrafter = agentSetup.createMachine({
  id: "email-drafter",
  output: ({ context }) => ({ sentEmails: context.sentEmails, failure: context.failure }),
  context: {
    prompt: "",
    assessment: null,
    draft: null,
    sentEmails: [],
    messages: [],
    revisions: 0,
    failure: null,
  },
  initial: "prompting",
  states: {
    prompting: {
      tags: ["awaiting-user"],
      meta: {
        interaction: {
          label: "What email should I write? Who is it to, and what should it say?",
          events: { PROMPT_SUBMITTED: { label: "Draft it", style: "primary" } },
          textEvent: "PROMPT_SUBMITTED",
        },
      },
      on: {
        PROMPT_SUBMITTED: ({ event }) => ({
          target: "evaluating",
          context: {
            prompt: event.text,
            assessment: null,
            draft: null,
            revisions: 0,
            messages: [userMessage(event.text)],
          },
        }),
      },
    },

    evaluating: {
      invoke: {
        src: "evaluatePrompt",
        input: ({ context }) => ({ prompt: context.prompt }),
        onDone: ({ output }) => ({
          target: output.satisfied ? "drafting" : "needsMoreInfo",
          context: { assessment: output },
        }),
        onError: ({ event }) => ({
          target: "failed",
          context: { failure: `evaluatePrompt failed: ${String(event.error)}` },
        }),
      },
    },

    needsMoreInfo: {
      tags: ["awaiting-user"],
      meta: {
        interaction: {
          label: "Some details are missing. Type them in, or draft anyway.",
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
          context: {
            prompt: `${context.prompt}\n\n${event.text}`,
            messages: [...context.messages, userMessage(event.text)],
          },
        }),
        DRAFT_ANYWAY: ({ context }) => ({
          target: "drafting",
          context: {
            prompt: `${context.prompt}\n\nDraft anyway with reasonable assumptions.`,
            messages: [
              ...context.messages,
              userMessage("Draft anyway with reasonable assumptions."),
            ],
          },
        }),
      },
    },

    drafting: {
      invoke: {
        src: "draftEmail",
        input: ({ context }) => ({
          prompt: context.prompt,
          messages: context.messages,
        }),
        onDone: ({ context, output: draft }) => ({
          // A spent revision budget is a different state, not a hidden guard:
          // `finalReview` simply does not accept REQUEST_CHANGES, so every
          // host — and `getInteraction` — stops offering it.
          target: context.revisions >= MAX_REVISIONS ? "finalReview" : "reviewing",
          context: {
            draft,
            messages: [
              ...context.messages,
              assistantMessage(`To: ${draft.to}\nSubject: ${draft.subject}\n\n${draft.body}`),
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
      tags: ["awaiting-user"],
      meta: {
        interaction: {
          label: "Send the draft, or type the changes you want.",
          events: {
            SEND: { label: "Send email", style: "primary" },
            REQUEST_CHANGES: { label: "Request changes" },
          },
          // Free text is a revision request, never a send.
          textEvent: "REQUEST_CHANGES",
        },
      },
      on: {
        REQUEST_CHANGES: ({ context, event }) => ({
          target: "drafting",
          context: {
            revisions: context.revisions + 1,
            prompt: `${context.prompt}\n\nRevision request: ${event.text}`,
            messages: [...context.messages, userMessage(`Revision request: ${event.text}`)],
          },
        }),
        SEND: { target: "sending" },
      },
    },

    // The same pause after MAX_REVISIONS rounds. The only difference is what
    // it accepts, which is exactly what a bounded loop should look like from
    // the outside.
    finalReview: {
      tags: ["awaiting-user"],
      meta: {
        interaction: {
          label: "That is the last revision I can make. Send this draft?",
          events: { SEND: { label: "Send email", style: "primary" } },
        },
      },
      on: {
        SEND: { target: "sending" },
      },
    },

    sending: {
      invoke: {
        src: "sendEmail",
        input: ({ context }) => ({ draft: context.draft! }),
        onDone: ({ context }) => ({
          target: "sent",
          context: {
            sentEmails: context.draft ? [...context.sentEmails, context.draft] : context.sentEmails,
          },
        }),
        onError: ({ event }) => ({
          target: "failed",
          context: { failure: `sendEmail failed: ${String(event.error)}` },
        }),
      },
    },

    sent: {
      tags: ["awaiting-user"],
      meta: {
        interaction: {
          label: "Email sent. Draft another one?",
          events: {
            ANOTHER: { label: "Draft another", style: "primary" },
            END: { label: "Finish up" },
          },
        },
      },
      on: {
        ANOTHER: {
          target: "prompting",
          context: {
            prompt: "",
            assessment: null,
            draft: null,
            revisions: 0,
          },
        },
        END: { target: "done" },
      },
    },

    // Two distinct final states, two distinct outputs: `failed` carries the
    // reason a request errored, `done` never does.
    failed: {
      type: "final",
      output: ({ context }) => ({
        sentEmails: context.sentEmails,
        failure: context.failure ?? "unknown failure",
      }),
    },
    done: {
      type: "final",
      output: ({ context }) => ({ sentEmails: context.sentEmails, failure: null }),
    },
  },
});

/** The machine's own event union. Hosts send these back after rendering. */
export type DrafterEvent = EventOf<typeof emailDrafter>;

/** One rendered interaction, as `getInteraction` returns it for this machine. */
export type Interaction = AgentInteraction<DrafterEvent>;
