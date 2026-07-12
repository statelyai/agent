/**
 * The flagship: an interactive email drafter that dogfoods the interaction
 * protocol. Every state that needs the human carries a schema-typed
 * `meta.interaction` (text / select / confirm); the direct-run host below
 * renders that meta *generically* — it never hardcodes state names — so the
 * machine fully owns the conversation shape.
 *
 * Flow: prompting → evaluating → (needsMoreInfo)? → drafting → reviewing →
 * sending → sent → (another | done). The model evaluates whether the request
 * is complete, drafts the email, and revises on request.
 *
 * Run: OPENAI_API_KEY=... npx tsx examples/email-drafter/index.ts
 */
import { z } from "zod";
import { openai } from "@ai-sdk/openai";
import { createAsyncLogic } from "xstate";
import { createAiSdkExecutors, defineModels } from "../../src/ai-sdk/index.js";
import { withReadline } from "../helpers/cli.js";
import { runExampleMain } from "../helpers/main.js";
import {
  type AgentMessage,
  assistantMessage,
  createAgentSchemas,
  createTextLogic,
  getStateMeta,
  runAgent,
  setupAgent,
  userMessage,
} from "../../src/index.js";

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
export const metaSchema = z.object({
  display: z.array(z.string()).optional(),
  interaction: z
    .discriminatedUnion("type", [
      z.object({
        type: z.literal("text"),
        label: z.string(),
        eventType: z.string(),
        field: z.string(),
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
      }),
      z.object({
        type: z.literal("confirm"),
        label: z.string(),
        default: z.boolean().optional(),
        trueEventType: z.string(),
        falseEventType: z.string(),
      }),
    ])
    .optional(),
});

const contextSchema = z.object({
  prompt: z.string(),
  assessment: promptAssessmentSchema.nullable(),
  draft: emailDraftSchema.nullable(),
  sentEmails: z.array(emailDraftSchema),
  messages: z.custom<AgentMessage[]>((value) => Array.isArray(value)),
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
  draftStreamer: openai("gpt-5.4-mini"),
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
      messages: z.custom<AgentMessage[]>((value) => Array.isArray(value)),
    }),
    output: emailDraftSchema,
  },
  model: "emailDrafter",
  system:
    "Draft a polished email from the request. Use the provided details without inventing missing essentials unless the user explicitly asked to draft anyway.",
  messages: ({ input }) => [...input.messages, userMessage(input.prompt)],
});

export const streamDraft = createTextLogic({
  mode: "stream",
  schemas: {
    input: z.object({ prompt: z.string() }),
    output: z.string(),
  },
  model: "draftStreamer",
  prompt: ({ input }) => input.prompt,
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
  streamDraft,
};

const agentSetup = setupAgent({
  schemas: emailDrafterSchemas,
  models,
  actorSources: emailDrafterActors,
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
      meta: {
        interaction: {
          type: "text",
          label: "Email draft request",
          eventType: "PROMPT_SUBMITTED",
          field: "prompt",
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
      meta: {
        interaction: {
          type: "select",
          label: "Next",
          choices: [
            {
              label: "Add details",
              eventType: "MORE_INFO",
              input: { type: "text", label: "More details", field: "details" },
            },
            { label: "Draft anyway", eventType: "DRAFT_ANYWAY" },
          ],
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
      meta: {
        interaction: {
          type: "select",
          label: "Next",
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
      meta: {
        display: ["Email sent."],
        interaction: {
          type: "confirm",
          label: "Send another?",
          default: false,
          trueEventType: "ANOTHER",
          falseEventType: "END",
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

// ─── Interactive CLI host (direct run) ───
//
// The dogfood: a generic renderer for the schema-typed interaction protocol.
// It reads `getStateMeta(snapshot).interaction` and drives the terminal purely
// from that meta — no state name is ever hardcoded. Swap this loop for a web
// form or Slack modal and the same machine drives it unchanged.

export type Interaction = NonNullable<z.infer<typeof metaSchema>["interaction"]>;
export type DrafterEvent = { type: string; [field: string]: unknown };

async function ask(
  rl: {
    question: (q: string) => Promise<string>;
  },
  q: string,
): Promise<string> {
  return (await rl.question(q)).trim();
}

/** Render one interaction and return the event the human chose. */
export async function promptInteraction(
  rl: { question: (q: string) => Promise<string> },
  interaction: Interaction,
  display: string[] | undefined,
): Promise<DrafterEvent> {
  for (const line of display ?? []) {
    console.log(line);
  }

  switch (interaction.type) {
    case "text": {
      const value = await ask(rl, `${interaction.label}: `);
      return { type: interaction.eventType, [interaction.field]: value };
    }
    case "confirm": {
      const answer = await ask(rl, `${interaction.label} [y/N]: `);
      const yes = /^y(es)?$/i.test(answer);
      return {
        type: yes ? interaction.trueEventType : interaction.falseEventType,
      };
    }
    case "select": {
      console.log(interaction.label);
      interaction.choices.forEach((choice, index) => {
        console.log(`  ${index + 1}. ${choice.label}`);
      });
      let choice = interaction.choices[0]!;
      for (;;) {
        const raw = await ask(rl, `Choose 1-${interaction.choices.length}: `);
        const picked = interaction.choices[Number(raw) - 1];
        if (picked) {
          choice = picked;
          break;
        }
        console.log("Please enter a valid number.");
      }
      const event: DrafterEvent = { type: choice.eventType };
      if (choice.input) {
        event[choice.input.field] = await ask(rl, `${choice.input.label}: `);
      }
      return event;
    }
  }
}

export async function main() {
  const executors = createAiSdkExecutors({ models });

  await withReadline(async (rl) => {
    // Start the machine; it settles idle at the first interaction state.
    let result = await runAgent(emailDrafter, {
      input: undefined,
      ...executors,
    });

    while (result.status === "idle") {
      const meta = getStateMeta<typeof result.snapshot, z.infer<typeof metaSchema>>(
        result.snapshot,
      );
      if (!meta.interaction) {
        // Idle with no interaction to render: nothing the human can do.
        console.error("Machine is idle with no interaction. Stopping.");
        break;
      }

      // Show the current draft whenever one exists, before the prompt.
      const draft = result.snapshot.context.draft;
      if (draft && meta.interaction.type !== "text") {
        console.log(
          `\n--- Draft ---\nTo: ${draft.to}\nSubject: ${draft.subject}\n\n${draft.body}\n-------------`,
        );
      }

      const event = await promptInteraction(rl, meta.interaction, meta.display);
      result = await runAgent(emailDrafter, {
        snapshot: result.snapshot,
        event: event as never,
        ...executors,
      });
    }

    if (result.status === "done") {
      console.log(`\nSent ${result.output.sentEmails.length} email(s).`);
    } else if (result.status === "error") {
      console.error("Run failed:", result.error);
    }
  });
}

runExampleMain(import.meta.url, main);
