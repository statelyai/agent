/**
 * The email drafter's agent logic: schemas, models, requests, actors, the agent
 * setup, and the machine itself. Everything a host needs, in one file and with
 * nothing host-flavored in it.
 *
 * Every framework host in `examples/` (Mastra, Flue, Eve, Cloudflare, the
 * inspector, the CLI in `./index.ts`) imports this module and nothing else from
 * the example. Each state that needs the human carries a schema-typed
 * `meta.interaction` (text / select / confirm), so hosts render the
 * conversation generically — they never hardcode state names.
 *
 * Flow: prompting → evaluating → (needsMoreInfo)? → drafting → reviewing →
 * sending → sent → (another | done).
 */
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { createAsyncLogic } from "xstate";
import { defineModels } from "@statelyai/agent/ai-sdk";
import {
  type AgentMessage,
  assistantMessage,
  createAgentSchemas,
  createTextLogic,
  setupAgent,
  userMessage,
} from "@statelyai/agent";

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

// State/transition meta is schema-typed: hosts get a typed interaction
// protocol instead of Record<string, unknown>.
// Every variant also carries the host-neutral chat vocabulary — an `events` map
// of button label + style per accepted event, and `textEvent` naming the ONE
// event free-typed text is delivered to. A chat host renders from those three
// fields (`label` / `events` / `textEvent`) and ignores the CLI-only
// `type`/`choices`/`field` details; the CLI renderer in `./index.ts` and the
// framework hosts keep using those. Same meta, two renderers.
const chatInteractionFields = {
  events: z
    .record(
      z.string(),
      z.object({
        label: z.string().optional(),
        style: z.enum(["primary", "danger", "default"]).optional(),
      }),
    )
    .optional(),
  textEvent: z.string().optional(),
};

export const metaSchema = z.object({
  display: z.array(z.string()).optional(),
  interaction: z
    .discriminatedUnion("type", [
      z.object({
        type: z.literal("text"),
        label: z.string(),
        eventType: z.string(),
        field: z.string(),
        ...chatInteractionFields,
      }),
      z.object({
        type: z.literal("select"),
        label: z.string(),
        choices: z.array(
          z.object({
            label: z.string(),
            eventType: z.string(),
            input: z
              .object({
                type: z.literal("text"),
                label: z.string(),
                field: z.string(),
              })
              .optional(),
          }),
        ),
        ...chatInteractionFields,
      }),
      z.object({
        type: z.literal("confirm"),
        label: z.string(),
        default: z.boolean().optional(),
        trueEventType: z.string(),
        falseEventType: z.string(),
        ...chatInteractionFields,
      }),
    ])
    .optional(),
});

/** One rendered interaction, as declared by the machine's `meta`. */
export type Interaction = NonNullable<z.infer<typeof metaSchema>["interaction"]>;

/** The event a host sends back after rendering an interaction. */
export type DrafterEvent = { type: string; [field: string]: unknown };

const contextSchema = z.object({
  prompt: z.string(),
  assessment: promptAssessmentSchema.nullable(),
  draft: emailDraftSchema.nullable(),
  sentEmails: z.array(emailDraftSchema),
  messages: z.custom<AgentMessage[]>((v) => Array.isArray(v)),
});

const eventSchemas = {
  PROMPT_SUBMITTED: z.object({ prompt: z.string() }),
  MORE_INFO: z.object({ details: z.string() }),
  DRAFT_ANYWAY: z.object({}),
  REQUEST_CHANGES: z.object({ changes: z.string() }),
  SEND: z.object({}),
  ANOTHER: z.object({}),
  END: z.object({}),
};

const outputSchema = z.object({ sentEmails: z.array(emailDraftSchema) });

export const models = defineModels({
  promptEvaluator: openai("gpt-5.4-mini"),
  emailDrafter: openai("gpt-5.4-mini"),
});

export const evaluatePrompt = createTextLogic({
  schemas: {
    input: z.object({ prompt: z.string() }),
    output: promptAssessmentSchema,
  },
  model: "promptEvaluator",
  system:
    "Evaluate an email drafting request. Require recipient, subject, and body details. Return missing fields and one question per gap.",
  prompt: ({ input }) => input.prompt,
});

export const draftEmail = createTextLogic({
  schemas: {
    input: z.object({
      prompt: z.string(),
      messages: z.custom<AgentMessage[]>((v) => Array.isArray(v)),
    }),
    output: emailDraftSchema,
  },
  model: "emailDrafter",
  system:
    "Draft a polished email from the request. Use the provided details without inventing missing essentials unless the user explicitly asked to draft anyway.",
  messages: ({ input }) => [...input.messages, userMessage(input.prompt)],
});

export const emailDrafterSchemas = createAgentSchemas({
  context: contextSchema,
  events: eventSchemas,
  output: outputSchema,
  meta: metaSchema,
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
  // The machine's own wait signal: the `awaiting-user` tag. Every state that
  // needs the human carries it, so `runAgent` settles idle deterministically.
  isSuspended: (snapshot) => snapshot.hasTag("awaiting-user"),
  actors: emailDrafterActors,
});

export const emailDrafter = agentSetup.createMachine({
  id: "email-drafter",
  output: ({ context }) => ({ sentEmails: context.sentEmails }),
  context: {
    prompt: "",
    assessment: null,
    draft: null,
    sentEmails: [],
    messages: [],
  },
  initial: "prompting",
  states: {
    prompting: {
      tags: ["awaiting-user"],
      meta: {
        interaction: {
          type: "text",
          label: "What email should I write? Who is it to, and what should it say?",
          eventType: "PROMPT_SUBMITTED",
          field: "prompt",
          events: { PROMPT_SUBMITTED: { label: "Draft it", style: "primary" } },
          textEvent: "PROMPT_SUBMITTED",
        },
      },
      on: {
        PROMPT_SUBMITTED: ({ event }) => ({
          target: "evaluating",
          context: {
            prompt: event.prompt,
            assessment: null,
            draft: null,
            messages: [userMessage(event.prompt)],
          },
        }),
      },
    },

    evaluating: {
      invoke: {
        src: "evaluatePrompt",
        input: ({ context }) => ({ prompt: context.prompt }),
        onDone: ({ output }) => {
          if (output.satisfied) {
            return {
              target: "drafting",
              context: { assessment: output },
            };
          }

          return {
            target: "needsMoreInfo",
            context: { assessment: output },
          };
        },
        onError: { target: "failed" },
      },
    },

    needsMoreInfo: {
      tags: ["awaiting-user"],
      meta: {
        interaction: {
          type: "select",
          label: "Some details are missing. Type them in, or draft anyway.",
          choices: [
            {
              label: "Add details",
              eventType: "MORE_INFO",
              input: { type: "text", label: "More details", field: "details" },
            },
            { label: "Draft anyway", eventType: "DRAFT_ANYWAY" },
          ],
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
            prompt: `${context.prompt}\n\n${event.details}`,
            messages: [...context.messages, userMessage(event.details)],
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
        onDone: ({ context, output }) => {
          const draft = output;
          return {
            target: "reviewing",
            context: {
              draft,
              messages: [
                ...context.messages,
                assistantMessage(`To: ${draft.to}\nSubject: ${draft.subject}\n\n${draft.body}`),
              ],
            },
          };
        },
        onError: { target: "failed" },
      },
    },

    reviewing: {
      tags: ["awaiting-user"],
      meta: {
        interaction: {
          type: "select",
          label: "Send the draft, or type the changes you want.",
          choices: [
            {
              label: "Request changes",
              eventType: "REQUEST_CHANGES",
              input: {
                type: "text",
                label: "Requested changes",
                field: "changes",
              },
            },
            { label: "Send", eventType: "SEND" },
          ],
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
            prompt: `${context.prompt}\n\nRevision request: ${event.changes}`,
            messages: [...context.messages, userMessage(`Revision request: ${event.changes}`)],
          },
        }),
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
        onError: { target: "failed" },
      },
    },

    sent: {
      tags: ["awaiting-user"],
      meta: {
        display: ["Email sent."],
        interaction: {
          type: "confirm",
          label: "Email sent. Draft another one?",
          default: false,
          trueEventType: "ANOTHER",
          falseEventType: "END",
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
          },
        },
        END: { target: "done" },
      },
    },

    // Plain final states: `output` is natively typed against the machine's
    // output schema, and becomes the machine output when reached.
    failed: {
      type: "final",
      output: ({ context }) => ({ sentEmails: context.sentEmails }),
    },
    done: {
      type: "final",
      output: ({ context }) => ({ sentEmails: context.sentEmails }),
    },
  },
});
